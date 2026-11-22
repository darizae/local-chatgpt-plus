import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpUpstreamManager } from "../lib/mcp-upstream-manager.js";
import {
  COMPUTER_USE_PROVIDER_IDS,
  allowedComputerUseTools,
  validateComputerUseTool,
  type ComputerUseProvider,
} from "../lib/computer-use-policy.js";
import { requireUnsafeRuntimeAllowed, requireWriteAllowed } from "../lib/permissions.js";
import { audit } from "../lib/audit.js";
import { toolResult } from "../lib/tool-result.js";
import { needsComputerApproval, requireComputerApproval } from "../lib/computer-approval.js";
import {
  RelayCdpClient,
  type RelayBrowserOp,
  type RelayBrowserOutcome,
} from "../lib/omp-browser-relay-cdp.js";
import type { RelayTarget } from "../lib/omp-browser-relay.js";

type UpstreamResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
};

function summarizeUpstream(raw: unknown) {
  const result = (raw ?? {}) as UpstreamResult;
  const text = (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
  let envelope: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) envelope = parsed as Record<string, unknown>;
  } catch {}
  const payload = result.structuredContent ?? envelope;
  const nested = payload?.response && typeof payload.response === "object"
    ? payload.response as Record<string, unknown> : null;
  const successful = result.isError !== true &&
    payload?.ok !== false && nested?.ok !== false &&
    (typeof payload?.exitCode !== "number" || payload.exitCode === 0);
  // Upstream failures include delivery metadata. Never retry uncertain delivery.
  const error = payload?.error && typeof payload.error === "object"
    ? payload.error as Record<string, unknown> : null;
  const disposition = error?.disposition && typeof error.disposition === "object"
    ? error.disposition as Record<string, unknown> : null;
  const retrySafe = !successful &&
    disposition?.delivery === "not_delivered" && disposition?.retry === "safe";
  const asText = JSON.stringify(payload ?? text);
  return {
    ok: successful,
    retrySafe,
    payload,
    text: asText.slice(0, 60_000),
    truncated: asText.length > 60_000,
    images: (result.content ?? []).filter((item) => item.type === "image"),
  };
}

// P1.13 opt-in OMP relay browser surface. When LCP_BROWSER_RELAY_URL is set,
// browser observe/act on an explicitly selected already-open tab runs over the
// relay's raw CDP instead of Vercel's agent-browser (which takes over the
// owner's browser). The supported surface is deliberately bounded: read text /
// URL / title, and click / fill by a fixed, length-bounded CSS selector on the
// exact revalidated target. Everything else fails closed — never a silent
// Vercel/desktop fallback, never navigation, never arbitrary page eval.
const RELAY_OBSERVE_OPS: Record<string, "getText" | "getUrl" | "getTitle"> = {
  agent_browser_snapshot: "getText",
  agent_browser_get_text: "getText",
  agent_browser_get_url: "getUrl",
  agent_browser_get_title: "getTitle",
};

function relayClient(): RelayCdpClient {
  const base = process.env.LCP_BROWSER_RELAY_URL;
  if (!base) throw new Error("OMP Browser Relay is not configured (LCP_BROWSER_RELAY_URL)");
  return new RelayCdpClient(base);
}

/** Explicit opaque target id + exact URL, revalidated against /json/list before every action. */
function relayTargetArgs(args: Record<string, unknown>): { targetId: string; url: string } {
  const targetId = typeof args.target === "string" ? args.target.trim() : "";
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!targetId) throw new Error("OMP relay browser operations require an explicit 'target' opaque target id");
  if (!url) throw new Error("OMP relay browser operations require the exact 'url' of the tab to revalidate");
  if (targetId.length > 200 || url.length > 4000) throw new Error("relay target/url arguments exceed safe bounds");
  return { targetId, url };
}

function relayActOp(tool: string, args: Record<string, unknown>): RelayBrowserOp {
  const selector = typeof args.selector === "string" ? args.selector.trim() : "";
  if ((tool === "agent_browser_click" || tool === "agent_browser_fill") && !selector) {
    throw new Error(`${tool} via OMP relay requires a non-empty 'selector'`);
  }
  if (selector.length > 200) throw new Error("selector exceeds the 200-char safe bound");
  if (tool === "agent_browser_click") return { kind: "click", selector };
  if (tool === "agent_browser_fill") {
    const value = typeof args.value === "string" ? args.value : (typeof args.text === "string" ? args.text : "");
    if (value.length > 4000) throw new Error("value exceeds the 4000-char safe bound");
    return { kind: "fill", selector, value };
  }
  throw new Error(
    "OMP relay browser actions support only agent_browser_click/agent_browser_fill on an already-open bound tab; " +
    tool + " is not supported (no navigation, no Vercel fallback)"
  );
}

/** Envelope shape every MCP tool handler returns (text content only). */
type RelayToolEnvelope = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
};

async function relayObserve(tool: string, args: Record<string, unknown>): Promise<RelayToolEnvelope> {
  // Read-only target listing: never requires allow_input, exposes only non-
  // credential tab metadata (opaque id, url, title, active).
  if (tool === "agent_browser_tab_list") {
    requireUnsafeRuntimeAllowed("browser target discovery");
    let targets: RelayTarget[];
    try {
      targets = await relayClient().listTargets();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await audit({ tool: "computer_observe", action: tool, target: "browser", status: "error", details: { relay_error: message } });
      return toolResult("computer_observe", { provider: "browser", tool, output: message, truncated: false },
        { ok: false, summary: "relay target discovery failed" });
    }
    await audit({ tool: "computer_observe", action: tool, target: "browser", status: "ok" });
    return toolResult("computer_observe", {
      provider: "browser", tool,
      targets: targets.map((t) => ({ targetId: t.targetId, url: t.url, title: t.title, active: t.active })),
      output: "select a tab by exact target id + url",
    }, { ok: true, summary: "discovered " + targets.length + " already-open relay tab(s); select one by target id + exact url" });
  }
  const kind = RELAY_OBSERVE_OPS[tool];
  if (!kind) {
    throw new Error(
      "OMP relay observation supports only agent_browser_tab_list / agent_browser_snapshot/get_text/get_url/get_title on an already-open tab; " +
      tool + " is not supported"
    );
  }
  requireUnsafeRuntimeAllowed("desktop/browser observation");
  const { targetId, url } = relayTargetArgs(args);
  const client = relayClient();
  let outcome: RelayBrowserOutcome;
  try {
    outcome = await client.run(targetId, url, { kind });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit({ tool: "computer_observe", action: tool, target: "browser", status: "error", details: { relay_error: message } });
    return toolResult("computer_observe", { provider: "browser", tool, output: message, truncated: false },
      { ok: false, summary: "relay observation failed; no Vercel/desktop fallback" });
  }
  await audit({ tool: "computer_observe", action: tool, target: "browser", status: outcome.ok ? "ok" : "error" });
  return toolResult("computer_observe", { provider: "browser", tool, output: outcome.text, truncated: outcome.truncated === true },
    { ok: outcome.ok, summary: outcome.ok ? "relay observation complete" : "relay observation failed" });
}

async function relayConnect(args: Record<string, unknown>): Promise<RelayToolEnvelope> {
  requireUnsafeRuntimeAllowed("browser target discovery");
  void args; // target is policy-validated loopback; discovery always uses the configured relay
  let targets: Awaited<ReturnType<RelayCdpClient["listTargets"]>>;
  try {
    targets = await relayClient().listTargets();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit({ tool: "computer_act", action: "agent_browser_connect", target: "browser", status: "error", details: { relay_error: message } });
    return toolResult("computer_act", { provider: "browser", tool: "agent_browser_connect", action_output: message, attempts: 1, verification: { checked: false, passed: null, snapshot: "" }, screenshot_fallback: null },
      { ok: false, summary: "relay target discovery failed" });
  }
  await audit({ tool: "computer_act", action: "agent_browser_connect", target: "browser", status: "ok" });
  return toolResult("computer_act", {
    provider: "browser", tool: "agent_browser_connect",
    targets: targets.map((t) => ({ targetId: t.targetId, url: t.url, title: t.title, active: t.active })),
    action_output: "discovered " + targets.length + " already-open relay tab(s); select one by target id + exact url",
    attempts: 1, verification: { checked: false, passed: null, snapshot: "" }, screenshot_fallback: null,
  }, { ok: true, summary: "discovered " + targets.length + " already-open relay tab(s); select one by target id + exact url" });
}

async function relayAct(
  tool: string,
  args: Record<string, unknown>,
  expected_text: string | undefined,
  allow_input: boolean,
  screenshot_on_failure: boolean,
): Promise<RelayToolEnvelope> {
  if (!allow_input) throw new Error("Computer input requires allow_input=true and user authorization");
  if (screenshot_on_failure) throw new Error("screenshot_on_failure is not supported by the OMP relay browser surface");
  requireWriteAllowed();
  requireUnsafeRuntimeAllowed("computer-use input");
  const op = relayActOp(tool, args);
  const { targetId, url } = relayTargetArgs(args);
  const client = relayClient();
  try {
    await requireComputerApproval("browser", tool, "relay:" + targetId);
  } catch (error) {
    await audit({ tool: "computer_act", action: "operator_approval", target: "browser", status: "error", details: { tool, denied: true } });
    throw error;
  }
  let outcome: RelayBrowserOutcome;
  try {
    outcome = await client.run(targetId, url, op);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit({ tool: "computer_act", action: tool, target: "browser", status: "error", details: { relay_error: message } });
    return toolResult("computer_act", { provider: "browser", tool, action_output: message, attempts: 1, verification: { checked: false, passed: null, snapshot: "" }, screenshot_fallback: null },
      { ok: false, summary: "relay browser action failed; not retried" });
  }
  // Relay actions are never blindly replayed: the click/fill already ran.
  let verification: { checked: boolean; passed: boolean | null; snapshot: string; error?: string } = {
    checked: false, passed: null, snapshot: "",
  };
  if (outcome.ok && expected_text) {
    try {
      const snap = await client.run(targetId, url, { kind: "getText" });
      verification = { checked: true, passed: snap.ok && snap.text.includes(expected_text), snapshot: snap.text.slice(0, 20_000) };
    } catch (error) {
      verification = { checked: true, passed: false, snapshot: "", error: error instanceof Error ? error.message : String(error) };
    }
  }
  const success = outcome.ok && verification.passed !== false;
  await audit({ tool: "computer_act", action: tool, target: "browser", status: success ? "ok" : "error", details: { verified: verification.passed, attempts: 1 } });
  return toolResult("computer_act", {
    provider: "browser", tool, action_output: outcome.ok ? outcome.text : (outcome.error ?? "action failed"), attempts: 1,
    verification, screenshot_fallback: null,
  }, {
    ok: success,
    summary: !outcome.ok ? "Relay browser action failed; not retried" :
      verification.passed === false ? "Action completed but expected state was not verified" :
        expected_text ? "Relay browser action verified" : "Relay browser action sent; no expected state provided",
  });
}

function mustEnableProvider(manager: McpUpstreamManager, provider: ComputerUseProvider): string {
  const serverId = COMPUTER_USE_PROVIDER_IDS[provider];
  const config = manager.getServerConfig(serverId);
  if (!config?.enabled || config.transport !== "stdio") {
    throw new Error(provider + " computer-use MCP is not enabled. Add and review the Vercel preset in Admin UI first.");
  }
  return serverId;
}

export function registerComputerUseTools(server: McpServer, manager: McpUpstreamManager): void {
  const providerSchema = z.enum(["desktop", "browser"]);
  const argumentSchema = z.record(z.string(), z.unknown()).optional().default({});
  // Qualified accessibility refs are tied to the window-scoped observation
  // that returned them, not to an unrelated caller-supplied verification target.
  // This registry is local to the MCP session; refs expire and are invalidated
  // after every desktop input to avoid acting on stale UI state.
  const observedRefs = new Map<string, { windowId: string; capturedAt: number }>();
  const REF_TTL_MS = 60_000;
  function rememberWindowRefs(payload: Record<string, unknown> | null | undefined, windowId: string): void {
    const data = payload?.data as Record<string, unknown> | undefined;
    if (!data?.tree) return;
    const now = Date.now();
    for (const [ref, entry] of observedRefs) {
      if (now - entry.capturedAt >= REF_TTL_MS) observedRefs.delete(ref);
    }
    let visited = 0;
    function visit(node: unknown): void {
      if (++visited > 5000 || !node || typeof node !== "object") return;
      const item = node as { ref_id?: unknown; children?: unknown };
      if (typeof item.ref_id === "string" && /^@[^\s:]+:e\d+$/.test(item.ref_id)) {
        observedRefs.set(item.ref_id, { windowId, capturedAt: now });
      }
      if (Array.isArray(item.children)) for (const child of item.children) visit(child);
    }
    visit(data.tree);
    while (observedRefs.size > 5000) observedRefs.delete(observedRefs.keys().next().value!);
  }
  server.registerTool(
    "computer_observe",
    {
      title: "Observe Desktop or Browser",
      description: "Read accessible desktop UI or browser state through installed Vercel MCP providers or the OMP Browser Relay. When the relay is configured (LCP_BROWSER_RELAY_URL), browser tools act on an explicitly selected already-open tab: agent_browser_tab_list lists tabs read-only (select by exact target id + url); agent_browser_get_text/get_url/get_title operate on a bound tab. Never modifies UI.",
      inputSchema: {
        provider: providerSchema,
        tool: z.string().optional().describe("Allowed observation tool; omit to list supported tools and provider status"),
        arguments: argumentSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ provider, tool, arguments: args }) => {
      const serverId = COMPUTER_USE_PROVIDER_IDS[provider];
      const config = manager.getServerConfig(serverId);
      if (!tool) {
        return toolResult("computer_observe", {
          provider,
          configured: Boolean(config),
          enabled: Boolean(config?.enabled),
          tools: allowedComputerUseTools(provider, "observe"),
          note: "An enabled provider is necessary to observe live UI.",
        });
      }
validateComputerUseTool(provider, "observe", tool, args);
      if (provider === "browser") {
        const relayArgs = (args ?? {}) as Record<string, unknown>;
        if (process.env.LCP_BROWSER_RELAY_URL) {
          return await relayObserve(tool, relayArgs);
        }
        // An explicit already-open tab target only exists on the relay; never
        // silently hand a target-id request to Vercel/desktop.
        if (typeof relayArgs.target === "string" && relayArgs.target.trim().length > 0) {
          throw new Error("an explicit relay tab target was requested but OMP Browser Relay is not configured; no Vercel/desktop fallback");
        }
      }
      // A read-only filesystem sandbox must not implicitly expose all windows,
      // pages and screenshots from the user's interactive desktop.
      requireUnsafeRuntimeAllowed("desktop/browser observation");
      mustEnableProvider(manager, provider);
      const advertised = await manager.listTools(serverId);
      if (!advertised.some((item) => item.name === tool)) throw new Error("Unsupported upstream observation tool: " + tool);
      const result = summarizeUpstream(await manager.callTool(serverId, tool, args));
      if (provider === "desktop" && tool === "desktop_snapshot" && result.ok &&
        typeof args.window_id === "string") {
        rememberWindowRefs(result.payload, args.window_id);
      }
      await audit({ tool: "computer_observe", action: tool, target: provider, status: result.ok ? "ok" : "error" });
      const output = toolResult("computer_observe", {
        provider, tool, output: result.text, truncated: result.truncated,
      }, { ok: result.ok, summary: result.ok ? provider + " observation complete" : provider + " observation failed" });
      // Preserve image content from screenshots without duplicating base64 inside JSON.
      return { ...output, content: [...output.content, ...result.images] } as typeof output;
    }
  );

  server.registerTool(
    "computer_act",
    {
      title: "Act on Desktop or Browser",
      description: "Explicitly authorized computer interaction through Vercel MCP or the OMP Browser Relay. Requires allow_input=true. On the relay, click/fill act on an explicitly selected already-open tab and require operator approval (may submit a sensitive form; never silently replayed or retried). agent_browser_connect lists tabs read-only; select by exact target id + exact url. Optional expected_text verifies resulting UI via a fresh snapshot; a failed action is never blindly retried.",
      inputSchema: {
        provider: providerSchema,
        tool: z.string().min(1).describe("Allowed input/navigation tool"),
        arguments: argumentSchema,
        allow_input: z.boolean().optional().default(false).describe("Must be true for actual user-visible interaction"),
        expected_text: z.string().max(1000).optional().describe("Optional text expected in a new post-action snapshot"),
        verification_target: z.object({
          app: z.string().min(1).max(200).optional(),
          window_id: z.string().min(1).max(200).optional(),
        }).optional().describe("Desktop window_id must match a previously observed window-scoped snapshot for input by ref"),
        safe_retries: z.number().int().min(0).max(1).optional().default(0).describe("Retry only when upstream confirms the action was NOT delivered and retry is safe"),
        screenshot_on_failure: z.boolean().optional().default(false),
      },
      // Computer input changes external state, so never mark it auto-approved.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ provider, tool, arguments: args, allow_input, expected_text, verification_target, safe_retries, screenshot_on_failure }) => {
      if (!allow_input) throw new Error("Computer input requires allow_input=true and user authorization");
      requireWriteAllowed();
      requireUnsafeRuntimeAllowed("computer-use input");
      validateComputerUseTool(provider, "act", tool, args);
      if (provider === "browser") {
        const relayArgs = (args ?? {}) as Record<string, unknown>;
        if (process.env.LCP_BROWSER_RELAY_URL) {
          if (tool === "agent_browser_connect") return await relayConnect(relayArgs);
          return await relayAct(tool, relayArgs, expected_text, allow_input, screenshot_on_failure);
        }
        // An explicit already-open tab target only exists on the relay; never
        // silently hand a target-id request to Vercel/desktop.
        if (typeof relayArgs.target === "string" && relayArgs.target.trim().length > 0) {
          throw new Error("an explicit relay tab target was requested but OMP Browser Relay is not configured; no Vercel/desktop fallback");
        }
      }
      if (provider === "desktop") {
        if ((expected_text || screenshot_on_failure) && !verification_target?.window_id) {
          throw new Error("Desktop verification/screenshot requires verification_target.window_id");
        }
        if (tool !== "desktop_wait" && !verification_target?.window_id) {
          throw new Error("Desktop input requires verification_target.window_id from a window-scoped snapshot");
        }
        if (tool === "desktop_focus_window") {
          if (args.window_id !== verification_target?.window_id) {
            throw new Error("Desktop focus target must match verification_target.window_id");
          }
        } else if (tool !== "desktop_wait") {
          const ref = args.ref_id;
          const binding = typeof ref === "string" ? observedRefs.get(ref) : undefined;
          if (!binding || binding.windowId !== verification_target?.window_id ||
            Date.now() - binding.capturedAt >= REF_TTL_MS) {
            throw new Error("Desktop ref_id is not bound to the specified window; call computer_observe desktop_snapshot with window_id first");
          }
        }
      }
      if (provider === "browser" && verification_target) {
        throw new Error("verification_target is only supported for desktop actions");
      }
      const serverId = mustEnableProvider(manager, provider);
      const available = await manager.listTools(serverId);
      if (!available.some((item) => item.name === tool)) throw new Error("Unsupported upstream input tool: " + tool);

      const approvalScope = provider === "desktop"
        ? verification_target?.window_id || "desktop-global"
        : tool === "agent_browser_connect" && typeof args.target === "string"
          ? "cdp:" + args.target
          : tool === "agent_browser_open" && typeof args.url === "string"
            ? "browser:" + new URL(args.url).origin
            : "browser-session";
      try {
        await requireComputerApproval(provider, tool, approvalScope);
        if (needsComputerApproval(tool)) {
          await audit({ tool: "computer_act", action: "operator_approval", target: provider,
            status: "ok", details: { tool, approval_scope: "short_lived" } });
        }
      } catch (error) {
        await audit({ tool: "computer_act", action: "operator_approval", target: provider,
          status: "error", details: { tool, denied: true } });
        throw error;
      }

      let outcome = summarizeUpstream(await manager.callTool(serverId, tool, args));
      let attempts = 1;
      if (!outcome.ok && safe_retries > 0 && outcome.retrySafe) {
        outcome = summarizeUpstream(await manager.callTool(serverId, tool, args));
        attempts += 1;
      }
      if (provider === "desktop" && tool !== "desktop_wait") observedRefs.clear();
      let verification: { checked: boolean; passed: boolean | null; snapshot: string; error?: string } = {
        checked: false, passed: null, snapshot: "",
      };
      let screenshot: ReturnType<typeof summarizeUpstream> | undefined;
      if (outcome.ok && expected_text) {
        const snapshotTool = provider === "desktop" ? "desktop_snapshot" : "agent_browser_snapshot";
        const snapshotArgs = provider === "desktop" ? { ...verification_target } : {};
        try {
          const observed = summarizeUpstream(await manager.callTool(serverId, snapshotTool, snapshotArgs));
          verification = {
            checked: true,
            passed: observed.ok && observed.text.includes(expected_text),
            snapshot: observed.text.slice(0, 20_000),
          };
        } catch (error) {
          verification = {
            checked: true, passed: false, snapshot: "",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (screenshot_on_failure && (!outcome.ok || verification.passed === false)) {
        try {
          screenshot = summarizeUpstream(await manager.callTool(
            serverId,
            provider === "desktop" ? "desktop_screenshot" : "agent_browser_screenshot",
            provider === "desktop" ? { ...verification_target } : {},
          ));
        } catch {}
      }
      const success = outcome.ok && verification.passed !== false;
      await audit({ tool: "computer_act", action: tool, target: provider, status: success ? "ok" : "error",
        details: { verified: verification.passed, screenshot_fallback: Boolean(screenshot), attempts } });
      const output = toolResult("computer_act", {
        provider, tool, action_output: outcome.text, attempts,
        verification, screenshot_fallback: screenshot ? screenshot.text.slice(0, 4000) : null,
      }, {
        ok: success,
        summary: !outcome.ok ? (attempts > 1 ? "Computer action failed after one safe retry" : "Computer action failed; not retried") :
          verification.passed === false ? "Action completed but expected state was not verified" :
            expected_text ? "Computer action verified" : "Computer action sent; no expected state provided",
      });
      return { ...output, content: [...output.content, ...(screenshot?.images ?? [])] } as typeof output;
    }
  );
}