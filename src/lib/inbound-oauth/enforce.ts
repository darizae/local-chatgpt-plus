import { getCurrentAuthContext } from "./context.js";
import { TOOL_SCOPE_OVERRIDES, requiredScopeForKind, type Scope, type ToolKind } from "./scopes.js";

/**
 * Authoritative per-tool scope check. Reads the current request's authenticated
 * context (bound by the HTTP layer) and refuses any tool whose required scope is
 * not granted by the access token. No-op in token mode (baseline behavior).
 *
 * `kind` is the runtime tool classification (READ/EDIT/EXEC) already computed by
 * server-factory, which correctly reflects upstream <server>__<tool> proxies via
 * their annotations. Named overrides (e.g. computer-use, durable-state tools)
 * take precedence.
 */
export function enforceToolScope(toolName: string, kind: ToolKind): void {
  const auth = getCurrentAuthContext();
  if (!auth) return; // token mode / no OAuth context bound
  const required: Scope = TOOL_SCOPE_OVERRIDES[toolName] ?? requiredScopeForKind(kind);
  if (!auth.scopes.includes(required)) {
    throw new Error(
      `Insufficient scope: tool '${toolName}' requires '${required}' but the token grants [${auth.scopes.join(", ")}]`
    );
  }
}