#!/usr/bin/env node
import "dotenv/config";
import express from "express";
import path from "path";
import { randomUUID } from "crypto";

import {
  setDefaultCwd,
  getDefaultCwd,
  getFullDiskAccess,
} from "./lib/path-security.js";
import {
  consumeSessionTransportError,
  createSessionManager,
  extractRequestId,
  isInitializeRequest,
  MCP_JSON_RESPONSE,
  MCP_SSE_KEEPALIVE_MS,
} from "./lib/mcp-session-manager.js";
import { initUpstreamManager } from "./lib/mcp-upstream-manager.js";
import { logMcpHttpEvent, logMcpRequest } from "./lib/activity-log.js";
import {
  buildInstructionContext,
  summarizeInstructionContext,
  type InstructionContext,
} from "./lib/instruction-context.js";
import { getChatGptToolProfile } from "./lib/tool-profile.js";
import { shutdownLspSessions } from "./lib/lsp-client.js";
import { shutdownPtySessions } from "./tools/pty.js";
import { shutdownManagedProcesses } from "./tools/shell.js";
import {
  describePermissionProfile,
  setPermissionWorkspaceRoots,
} from "./lib/permissions.js";
import { shutdownSubagents } from "./lib/subagent-manager.js";
import { initializeRuntimeIdentity } from "./lib/runtime-identity.js";
import { pruneEphemeralState } from "./lib/state-maintenance.js";
import { createTunnelSupervisor } from "./lib/tunnel-supervisor.js";
import { listSessionRuntimeStates } from "./lib/session-context.js";
import { createInboundAuth, inboundAuthOptionsFromEnv } from "./lib/inbound-oauth/index.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";
const MCP_TOKEN = (process.env.MCP_TOKEN || "").trim();
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || "3001", 10);
const SHELL_TIMEOUT = (() => {
  const parsed = Number(process.env.SHELL_TIMEOUT || 300);
  if (!Number.isFinite(parsed) || parsed <= 0) return 300;
  return Math.min(Math.max(Math.trunc(parsed), 5), 3600);
})();
const SESSION_RECOVERY =
  (process.env.MCP_SESSION_RECOVERY || "true").toLowerCase() !== "false";

function splitWorkspaceEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(";")
    .map((p) => p.trim().replace(/^['\"]|['\"]$/g, ""))
    .filter(Boolean);
}

function resolveWorkspaceRoots(): string[] {
  const configuredRoots = [
    ...splitWorkspaceEnv(process.env.WORKSPACE_PATH || process.cwd()),
    ...splitWorkspaceEnv(process.env.EXTRA_WORKSPACE_PATHS),
    ...splitWorkspaceEnv(process.env.WORKSPACE_PATHS),
    ...splitWorkspaceEnv(process.env.ALLOWED_WORKSPACE_PATHS),
  ];

  const roots = configuredRoots.map((p) => path.resolve(p));
  return [...new Set(roots)];
}

const workspaceRoots = resolveWorkspaceRoots();
const workspaceRoot = workspaceRoots[0] || process.cwd();
setDefaultCwd(workspaceRoot);
setPermissionWorkspaceRoots(workspaceRoots);

// Inbound OAuth 2.1 resource-server integration. `oauth` mode fails closed at
// startup on invalid/missing configuration or an unreachable issuer; `token`
// mode preserves the exact existing MCP_TOKEN URL-path baseline.
const inboundAuth = await createInboundAuth(inboundAuthOptionsFromEnv());
// A loopback bind is not an authentication mechanism: an operator can later
// forward it through any tunnel. Empty-token operation is permitted ONLY in
// explicit, loopback-only disposable automated test fixtures.
if (!inboundAuth.isOauthMode && !MCP_TOKEN) {
  const testOnly = process.env.NODE_ENV === "test" &&
    process.env.LCP_ALLOW_UNAUTHENTICATED_TEST_ONLY === "1" &&
    (HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost");
  if (!testOnly) {
    throw new Error("Token mode requires MCP_TOKEN. Generate a random secret or configure inbound OAuth; never tunnel an unauthenticated MCP server.");
  }
}
if (inboundAuth.isOauthMode && MCP_TOKEN) {
  console.warn("[Auth] OAuth mode is active; the MCP_TOKEN URL-path is ignored (no tokenized route is registered).");
}

const upstreamManager = await initUpstreamManager();

const instructionContext: InstructionContext = await buildInstructionContext({
  workspaceRoot,
  workspaceRoots,
  pid: process.pid,
  adminPort: ADMIN_PORT,
});

if (instructionContext.projectMemory.sections.length > 0) {
  console.log(
    `[MCP] Project memory: ${instructionContext.projectMemory.sections.length} file(s) from ${workspaceRoot} (${instructionContext.projectMemory.total_bytes} bytes)`
  );
} else {
  console.log(
    `[MCP] Project memory: no CLAUDE.md/AGENTS.md at ${workspaceRoot} — set WORKSPACE_PATH to your project root`
  );
}
if (instructionContext.git.is_repo) {
  console.log(`[MCP] Git: branch ${instructionContext.git.branch}`);
}
console.log(
  `[MCP] MCP instructions: ${Math.round(instructionContext.instructionBytes / 1024)}KB (agent prompt + env + git + memory)`
);
console.log(`[MCP] Tool profile: ${getChatGptToolProfile()} (CHATGPT_TOOL_PROFILE)`);
const runtimeIdentity = initializeRuntimeIdentity(workspaceRoot);
console.log(`[MCP] Runtime: ${runtimeIdentity.run_id} schema=${runtimeIdentity.schema_hash} commit=${runtimeIdentity.build_commit || "unknown"}`);
if (runtimeIdentity.connector_refresh_recommended) {
  console.warn("[MCP] Tool schema changed since the previous run; refresh the ChatGPT connector and use a fresh chat after this restart.");
}
const stateMaintenance = await pruneEphemeralState().catch((error) => ({
  removed_files: 0,
  removed_bytes: 0,
  scanned_files: 0,
  errors: [error instanceof Error ? error.message : String(error)],
  retention_days: 30,
}));
if (stateMaintenance.removed_files > 0) {
  console.log(`[MCP] State maintenance: removed ${stateMaintenance.removed_files} expired ephemeral file(s), ${stateMaintenance.removed_bytes} bytes`);
}
if (stateMaintenance.errors.length) {
  console.warn(`[MCP] State maintenance warning: ${stateMaintenance.errors.slice(0, 3).join(" | ")}`);
}

const sessionManager = createSessionManager({
  workspaceRoot,
  shellTimeout: SHELL_TIMEOUT,
  workspaceRoots,
  port: PORT,
  projectMemoryInstructions: instructionContext.instructionsText,
  oauthIssuer: inboundAuth.issuer,
});
const tunnelSupervisor = createTunnelSupervisor({
  root: process.cwd(),
  mcpPort: PORT,
});

const app = express();
// Hosted MCP clients use server-to-server HTTPS; browser cross-origin reads
// are not part of this API. Do not reflect arbitrary Origins or enable CORS.
// The secure MCP tunnel has a 10 MiB request/response ceiling. Keep the local
// parser below that too so direct/local clients get a deterministic rejection
// instead of letting unusually large JSON bodies consume excessive memory.
app.use(express.json({ limit: "9mb" }));
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const bodyError = err as { type?: string; status?: number; message?: string } | undefined;
  if (bodyError?.type === "entity.too.large" || bodyError?.status === 413) {
    res.status(413).json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32002,
        message: "Request body is too large. Keep MCP requests below 9 MiB and chunk large file/content operations.",
      },
    });
    return;
  }
  if (bodyError instanceof SyntaxError || bodyError?.status === 400) {
    res.status(400).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid JSON request body" },
    });
    return;
  }
  next(err);
});
// ChatGPT may call either "/" or "/mcp" — support both.
// - oauth mode: the canonical `/mcp` (and `/`) routes, guarded by inbound Bearer
//   token validation. No tokenized path exists, so there is no OAuth bypass.
// - token mode (baseline): only the tokenized endpoints "/<token>" and
//   "/mcp/<token>" are valid; unguarded paths are handled below.
const MCP_PATHS = inboundAuth.isOauthMode
  ? ["/mcp", "/"]
  : MCP_TOKEN
    ? [`/${MCP_TOKEN}`, `/mcp/${MCP_TOKEN}`]
    : ["/", "/mcp"];
const MCP_PATHS_SET = new Set(MCP_PATHS);
// /health is unauthenticated, and startup output may be collected in logs.
// Keep the real token only in the route matcher, never in diagnostic output.
const DISPLAY_MCP_PATHS = !inboundAuth.isOauthMode && MCP_TOKEN
  ? ["/[REDACTED_MCP_TOKEN]", "/mcp/[REDACTED_MCP_TOKEN]"]
  : MCP_PATHS;

app.use((req, res, next) => {
  const started = Date.now();
  const isMcpRoute = MCP_PATHS_SET.has(req.path);
  const displayPath = MCP_TOKEN ? req.path.split(MCP_TOKEN).join("[REDACTED_MCP_TOKEN]") : req.path;
  res.on("finish", () => {
    const duration = Date.now() - started;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const sessionInfo = sessionId ? ` session=${String(sessionId).slice(0, 8)}...` : "";

    if (req.method === "POST" && isMcpRoute) {
      const transportError =
        consumeSessionTransportError(sessionId) ||
        (typeof res.locals.mcpError === "string" ? res.locals.mcpError : undefined);
      logMcpRequest(req.body, sessionId, duration, res.statusCode, transportError);
      return;
    }

    if (isMcpRoute && res.statusCode >= 400) {
      const reason =
        (typeof res.locals.mcpError === "string" ? res.locals.mcpError : undefined) ||
        (res.statusCode === 404
          ? "Session not found"
          : res.statusCode === 400
            ? "Bad Request (missing Mcp-Session-Id or invalid state)"
            : `HTTP ${res.statusCode}`);
      logMcpHttpEvent({
        method: req.method,
        path: displayPath,
        httpStatus: res.statusCode,
        durationMs: duration,
        sessionId,
        errorMessage: reason,
      });
      return;
    }

    if (!isMcpRoute) {
      console.log(`[HTTP] ${req.method} ${displayPath} ${res.statusCode} ${duration}ms${sessionInfo}`);
    }
  });
  next();
});

if (MCP_TOKEN && !inboundAuth.isOauthMode) {
  // Return 404, not 401: MCP clients interpret 401 as an OAuth challenge and may
  // start metadata discovery. A 404 correctly indicates that no endpoint exists here.
  for (const unguarded of ["/", "/mcp"]) {
    app.all(unguarded, (_req, res) => {
      res.status(404).json({ ok: false, error: "Not found" });
    });
  }
}

// In oauth mode advertise RFC 9728 protected-resource + RFC 8414 authorization
// server metadata so MCP clients can discover the issuer and scopes. Discovery
// endpoints are intentionally unauthenticated (the client must be able to learn
// where to authenticate). Only the MCP tool routes require a Bearer token.
if (inboundAuth.metadataRouter) {
  app.use(inboundAuth.metadataRouter);
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    name: "local-chatgpt-plus",
    workspace: workspaceRoot,
    defaultCwd: getDefaultCwd(),
    fullMachineAccess: getFullDiskAccess(),
    permission: describePermissionProfile(),
    fullDiskAccess: getFullDiskAccess(),
    activeSessions: sessionManager.count(),
    sessionRecovery: SESSION_RECOVERY,
    transportMode: MCP_JSON_RESPONSE ? "json" : "sse",
    sseKeepAliveMs: MCP_JSON_RESPONSE ? null : MCP_SSE_KEEPALIVE_MS,
    authMode: inboundAuth.isOauthMode ? "oauth" : "token",
    mcpEndpoints: DISPLAY_MCP_PATHS,
    instructions: summarizeInstructionContext(instructionContext),
  });
});

async function handleMcpPost(req: express.Request, res: express.Response): Promise<void> {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const requestId = extractRequestId(req.body);

    const existing = sessionId ? sessionManager.get(sessionId) : undefined;
    if (existing) {
      await sessionManager.handleExisting(existing, req, res, req.body);
      return;
    }

    if (isInitializeRequest(req.body)) {
      if (sessionId) {
        console.log(`[MCP] Re-initialize with stale session header: ${sessionId}`);
      }
      await sessionManager.createNew(req, res, req.body);
      return;
    }

    if (sessionId) {
      if (SESSION_RECOVERY) {
        const recovered = await sessionManager.tryRecoverStale(
          sessionId,
          req,
          res,
          req.body
        );
        if (recovered) return;
      }
      sessionManager.sendSessionNotFound(res, requestId);
      return;
    }

    // ChatGPT can send some requests (for example "server/discover") without an
    // Mcp-Session-Id. Returning 400 here can trigger endless connector retries, so
    // recover/create a session and let the SDK return a valid JSON-RPC response.
    if (SESSION_RECOVERY) {
      const adopted = await sessionManager.tryRecoverStale(
        randomUUID(),
        req,
        res,
        req.body
      );
      if (adopted) return;
    }

    sessionManager.sendBadRequest(
      res,
      "Bad Request: Mcp-Session-Id header is required",
      requestId
    );
  } catch (error) {
    console.log("[MCP] Error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: extractRequestId(req.body),
      });
    }
  }
}

function handleStaleSession(
  req: express.Request,
  res: express.Response,
  sessionId: string | undefined
): boolean {
  if (!sessionId || sessionManager.get(sessionId)) {
    return false;
  }
  sessionManager.sendSessionNotFound(res);
  return true;
}

async function handleMcpGet(req: express.Request, res: express.Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (handleStaleSession(req, res, sessionId)) return;

  if (!sessionId) {
    sessionManager.sendBadRequest(res, "Bad Request: Mcp-Session-Id header is required");
    return;
  }

  const session = sessionManager.get(sessionId);
  if (!session) {
    sessionManager.sendSessionNotFound(res);
    return;
  }

  await sessionManager.handleExisting(session, req, res, undefined);
}

async function handleMcpDelete(req: express.Request, res: express.Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (handleStaleSession(req, res, sessionId)) return;

  if (!sessionId) {
    sessionManager.sendBadRequest(res, "Bad Request: Mcp-Session-Id header is required");
    return;
  }

  const session = sessionManager.get(sessionId);
  if (!session) {
    sessionManager.sendSessionNotFound(res);
    return;
  }

  await sessionManager.handleExisting(session, req, res, undefined);
}

// Every MCP HTTP operation (initialize, tools/list, tools/call, GET/SSE,
// DELETE/session teardown) is guarded by inbound auth: a valid, audience-bound
// Bearer token with the base scope is required before any session/tool side
// effect. The validated request context (subject + scopes) is bound for the
// request so per-tool scope enforcement sees it. In token mode requireAuth and
// runWithContext are no-ops, preserving the existing behavior.
for (const mcpPath of MCP_PATHS) {
  app.post(mcpPath, inboundAuth.requireAuth, (req, res) =>
    inboundAuth.runWithContext(req.auth, () => handleMcpPost(req, res))
  );
  app.get(mcpPath, inboundAuth.requireAuth, (req, res) =>
    inboundAuth.runWithContext(req.auth, () => handleMcpGet(req, res))
  );
  app.delete(mcpPath, inboundAuth.requireAuth, (req, res) =>
    inboundAuth.runWithContext(req.auth, () => handleMcpDelete(req, res))
  );
}

sessionManager.startCleanup();

let server: ReturnType<typeof app.listen> | undefined;
const adminEnabled = (process.env.LOCAL_CODER_ADMIN_ENABLED || "false").toLowerCase() === "true";
const adminServer = adminEnabled ? (await import("./admin/server.js")).startAdminServer({
  port: ADMIN_PORT,
  host: "127.0.0.1",
  mcpPort: PORT,
  pid: process.pid,
  transportMode: MCP_JSON_RESPONSE ? "json" : "sse",
  keepAliveMs: MCP_SSE_KEEPALIVE_MS,
  manager: upstreamManager,
  sessionCount: () => sessionManager.count(),
  sessionSnapshot: () => listSessionRuntimeStates(),
  tunnelSnapshot: () => tunnelSupervisor.snapshot(),
  instructionSummary: () => summarizeInstructionContext(instructionContext),
  instructionsPreview: () => instructionContext.instructionsText,
}) : undefined;
adminServer?.on("error", (err: NodeJS.ErrnoException) => {
  shutdown("admin server error", 1, err);
});

// Keep terminal UI dependencies out of non-interactive and headless processes.
function wantsTerminalDashboard(): boolean {
  const pref = (process.env.LOCAL_CODER_TUI || "auto").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(pref)) return false;
  if (["1", "true", "on", "yes"].includes(pref)) return Boolean(process.stdout.isTTY);
  return Boolean(process.stdout.isTTY && process.env.TERM !== "dumb" && !process.env.CI);
}

type DashboardHandle = { active: boolean; renderNow: () => void; stop: () => void };
let terminalDashboard: DashboardHandle = {
  active: false,
  renderNow: () => {},
  stop: () => {},
};

server = app.listen(PORT, HOST, async () => {
  if (wantsTerminalDashboard()) {
    const { startTerminalDashboard } = await import("./lib/terminal-dashboard.js");
    terminalDashboard = startTerminalDashboard({
    mcpPort: PORT,
    adminPort: ADMIN_PORT,
    workspace: workspaceRoot,
    toolProfile: getChatGptToolProfile(),
    authEnabled: Boolean(MCP_TOKEN),
    permission: describePermissionProfile(),
    transportMode: MCP_JSON_RESPONSE ? "json" : "sse",
    keepAliveMs: MCP_SSE_KEEPALIVE_MS,
    sessionCount: () => sessionManager.count(),
    sessionSnapshot: () => listSessionRuntimeStates(),
    tunnelSnapshot: () => tunnelSupervisor.snapshot(),
    });
  }
  void tunnelSupervisor.start().then(() => terminalDashboard.renderNow()).catch((error) => {
    console.warn("[Tunnel] supervisor start failed:", error);
  });
  if (terminalDashboard.active) {
    terminalDashboard.renderNow();
    return;
  }

  console.log("");
  console.log("========================================");
  console.log("  Local ChatGPT Plus MCP");
  console.log("========================================");
  console.log(`  Local:     http://${HOST}:${PORT}`);
  console.log(`  MCP:       http://${HOST}:${PORT}${DISPLAY_MCP_PATHS[0]}`);
  console.log(`  MCP alt:   http://${HOST}:${PORT}${DISPLAY_MCP_PATHS[1]}`);
  console.log(`  Health:    http://${HOST}:${PORT}/health`);
  if (adminEnabled) console.log(`  Admin UI:  http://127.0.0.1:${ADMIN_PORT}/ui`);
  console.log(`  Default cwd: ${workspaceRoot}`);
  console.log(`  Permission: ${describePermissionProfile()}`);
  console.log(`  Session recovery: ${SESSION_RECOVERY ? "ON" : "OFF"}`);
  console.log(`  Transport: ${MCP_JSON_RESPONSE ? "JSON response" : `SSE keepalive ${MCP_SSE_KEEPALIVE_MS / 1000}s`}`);
  console.log(
    `  Auth:      ${inboundAuth.isOauthMode
      ? "ON (OAuth 2.1 Bearer tokens)"
      : MCP_TOKEN
        ? "ON (MCP_TOKEN in URL path)"
        : "OFF — set MCP_TOKEN in .env!"}`
  );
  console.log(`  PID:       ${process.pid}`);
  console.log(`  Run ID:    ${runtimeIdentity.run_id}`);
  console.log(`  Schema:    ${runtimeIdentity.schema_hash}`);
  console.log(`  Build:     ${runtimeIdentity.build_commit || "unknown"}`);
  console.log("========================================");
  console.log("  Running... (Ctrl+C to stop)");
  console.log("========================================");
  console.log("");
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n[ERROR] Port ${PORT} is already in use by another server!`);
    console.error("Run this command to find the process:");
    console.error(`  lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    console.error("Stop the previous process with Ctrl+C, or terminate its PID after verifying it.\n");
  } else {
    console.error("\n[ERROR] Could not start the server:", err.message, "\n");
  }
  shutdown("MCP server error", 1, err);
});

let shuttingDown = false;
function shutdown(signal: string, exitCode = 0, fatalError?: unknown): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  terminalDashboard.stop();
  if (fatalError !== undefined) {
    console.error(`\n[FATAL] ${signal}:`, fatalError);
  }
  console.log(`\n[STOP] Server is shutting down (${signal})...`);
  sessionManager.stopCleanup();
  const hardExit = setTimeout(() => process.exit(exitCode || 1), 7_500);
  hardExit.unref?.();
  void Promise.allSettled([
    upstreamManager.shutdown(),
    shutdownLspSessions(),
    shutdownPtySessions(),
    shutdownManagedProcesses(),
    shutdownSubagents(),
    tunnelSupervisor.stop(),
  ]).finally(() => {
    try {
      adminServer?.close();
    } catch {}
    if (!server) {
      clearTimeout(hardExit);
      process.exit(exitCode);
      return;
    }
    try {
      server.close(() => {
        clearTimeout(hardExit);
        process.exit(exitCode);
      });
    } catch {
      clearTimeout(hardExit);
      process.exit(exitCode);
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => shutdown("uncaughtException", 1, error));
process.on("unhandledRejection", (reason) => shutdown("unhandledRejection", 1, reason));

// Keep stdin open for an interactive macOS operator TUI.
if (process.stdin.isTTY) {
  process.stdin.resume();
}