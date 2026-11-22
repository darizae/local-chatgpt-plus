/**
 * Read-only "what is actually available" status for the two delegation paths:
 *  - OMP/model-backed subagents (independent runner, config in subagents.json)
 *  - native ChatGPT computer use (computer_observe / computer_act)
 *
 * This deliberately reports only non-secret, server-observable facts. The
 * `computer:use` OAuth *scope* is an external grant on the connector token and
 * cannot be proven from inside the resource server, so it is reported as
 * "external, needs re-verification", never as granted.
 */
import type { UpstreamServerConfig } from "./mcp-upstream-config.js";
import type { SubagentConfig } from "./subagent-manager.js";

export interface ComputerUseProviderState {
  id: string;
  name: string;
  transport: string;
  expose: string;
  enabled: boolean;
}

export interface SubagentReadiness {
  configured: boolean;
  enabled: boolean;
  executable: string | null;
  executable_resolvable: boolean;
  prompt_via_stdin: boolean;
  max_concurrency: number;
  timeout_ms: number;
  provider: string | null;
  model: string | null;
  hint: string;
}

export interface ComputerUseReadiness {
  providers: ComputerUseProviderState[];
  configured_provider_count: number;
  enabled_provider_count: number;
  unsafe_runtimes_allowed: boolean;
  permission_profile: string;
  scope_required: boolean;
  scope_grant_verified: "external" | "blocked";
  scope_note: string;
  hint: string;
}

export interface OrchestrationReadiness {
  subagent: SubagentReadiness;
  computer_use: ComputerUseReadiness;
}

const COMPUTER_USE_PROVIDER_IDS = new Set(["vercel-agent-desktop", "vercel-agent-browser"]);

const MODEL_FLAG_PATTERN = /^(?:--model|-m)(?:=|\s+)?(.+)$/;
// provider-qualified model id, e.g. deepseek-ai/DeepSeek-V4-Flash-0731
const QUALIFIED_MODEL = /^([a-z0-9][a-z0-9-_]*)\/([A-Za-z0-9._-]+)$/;

/**
 * Extract a safe, non-secret model/provider identifier from the subagent arg
 * list (e.g. the DeepInfra catalog entry `deepseek-ai/DeepSeek-V4-Flash-0731`).
 * Never returns credentials.
 */
export function extractModelFromArgs(args: string[]): { provider: string | null; model: string | null } {
  let candidate: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const flag = arg.match(MODEL_FLAG_PATTERN);
    if (flag) {
      candidate = flag[1].trim();
      break;
    }
    if (QUALIFIED_MODEL.test(arg)) {
      candidate = arg;
      break;
    }
  }
  if (!candidate) return { provider: null, model: null };
  const match = candidate.match(QUALIFIED_MODEL);
  if (match) return { provider: match[1], model: candidate };
  return { provider: null, model: candidate };
}

export function buildOrchestrationReadiness(input: {
  subagentConfig: SubagentConfig;
  upstreamServers: UpstreamServerConfig[];
  allowUnsafeRuntimes: boolean;
  permissionProfile: string;
  subagentExecutableResolvable?: boolean;
}): OrchestrationReadiness {
  const config = input.subagentConfig;
  const { provider, model } = extractModelFromArgs(config.args ?? []);
  const subagentConfigured = Boolean(config.enabled && config.executable);
  const subagent: SubagentReadiness = {
    configured: subagentConfigured,
    enabled: config.enabled === true,
    executable: config.executable || null,
    executable_resolvable: Boolean(
      input.subagentExecutableResolvable ?? (subagentConfigured ? true : false)
    ),
    prompt_via_stdin: config.prompt_via_stdin === true,
    max_concurrency: config.max_concurrency,
    timeout_ms: config.timeout_ms,
    provider,
    model,
    hint: subagentConfigured
      ? "OMP/model-backed subagent is enabled. No inference runs until a spawn is requested."
      : `Subagent runner is not enabled (enabled=${config.enabled === true}, executable=${config.executable ? "set" : "empty"}). Configure ${"profiles/subagents.json"} and approve model spending before use.`,
  };

  const providers = input.upstreamServers
    .filter((server) => COMPUTER_USE_PROVIDER_IDS.has(server.id))
    .map((server) => ({
      id: server.id,
      name: server.name,
      transport: server.transport,
      expose: server.expose ?? "meta_only",
      enabled: server.enabled !== false,
    }));

  const enabledProviders = providers.filter((p) => p.enabled);
  const computer_use: ComputerUseReadiness = {
    providers,
    configured_provider_count: providers.length,
    enabled_provider_count: enabledProviders.length,
    unsafe_runtimes_allowed: input.allowUnsafeRuntimes,
    permission_profile: input.permissionProfile,
    scope_required: true,
    scope_grant_verified: "external",
    scope_note:
      "Granting the `computer:use` scope is an Auth0/connector-authorization change performed by the owner; the resource server cannot prove the current token's scopes from here.",
    hint: enabledProviders.length
      ? "A computer-use provider is enabled, but `computer:use` scope + provider attachment + macOS permissions are still required and owner-approved."
      : "No computer-use provider is enabled and the `computer:use` scope is not granted. Direct ChatGPT browser/desktop use is blocked until an owner-approved provider + scope grant.",
  };

  return { subagent, computer_use };
}