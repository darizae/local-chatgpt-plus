/**
 * Inbound OAuth 2.1 scope taxonomy and per-tool scope enforcement.
 *
 * Scopes are coarse capability buckets the end user consents to once during
 * ChatGPT's OAuth login. The resource server advertises these in its RFC 9728
 * protected-resource metadata; a valid access token carries the subset the user
 * granted and every MCP tool call is checked against it (fail closed: a tool
 * whose scope is absent is refused even if the token is otherwise valid).
 */

export const SCOPES = {
  /** Base scope required for every MCP operation (initialize, tools/list, etc.). */
  connect: "mcp:connect",
  /** Read-only filesystem/project inspection (no mutation, no execution). */
  filesRead: "files:read",
  /** Filesystem and durable coding-state mutation (write/edit/delete/restore). */
  filesWrite: "files:write",
  /** Shell command / subprocess / Git / PTY / upstream execution. */
  commandsExecute: "commands:execute",
  /** Desktop/browser computer-use automation (computer_observe / computer_act). */
  computerUse: "computer:use",
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/** All scopes the resource server can grant, in advertised order. */
export const ALL_SCOPES: readonly Scope[] = [
  SCOPES.connect,
  SCOPES.filesRead,
  SCOPES.filesWrite,
  SCOPES.commandsExecute,
  SCOPES.computerUse,
];

/**
 * The runtime tool-kind classification (READ/EDIT/EXEC/MCP) mirrors the existing
 * classification in server-factory and maps 1:1 to a required scope. This keeps
 * per-tool enforcement consistent for native tools AND upstream <server>__<tool>
 * proxies. Upstream proxies are conservatively command-scoped because a proxy can
 * run arbitrary upstream tools (matching the existing unsafe-runtime gate).
 */
export type ToolKind = "READ" | "EDIT" | "EXEC" | "MCP";

export function requiredScopeForKind(kind: ToolKind): Scope {
  switch (kind) {
    case "READ":
      return SCOPES.filesRead;
    case "EDIT":
      return SCOPES.filesWrite;
    case "EXEC":
    case "MCP":
      return SCOPES.commandsExecute;
  }
}

/**
 * Static native-tool → scope mapping, used both for documentation and as a
 * cross-check against the registration-time kind classification. Tools whose
 * primary effect is durable coding-workflow state or recovery are treated as
 * write-scoped (fail closed), since they can drive file mutation via
 * transaction/restore paths.
 */
export const TOOL_SCOPE_OVERRIDES: Record<string, Scope> = {
  // Computer-use automation is gated by its own scope.
  computer_observe: SCOPES.computerUse,
  computer_act: SCOPES.computerUse,

  // Durable coding-workflow state machines can restore files / run commands.
  agent_task: SCOPES.filesWrite,
  coding_loop: SCOPES.commandsExecute, // verify/run drives subprocesses
  coding_loop_status: SCOPES.filesRead,
  edit_transaction: SCOPES.filesWrite,
  context_capsule: SCOPES.filesWrite, // checkpoint persists state
  remember: SCOPES.filesWrite,
  rewind: SCOPES.filesWrite, // restore mutates checkpoints/files

  // Upstream MCP call is arbitrary → conservatively command-scoped.
  mcp_call: SCOPES.commandsExecute,
};