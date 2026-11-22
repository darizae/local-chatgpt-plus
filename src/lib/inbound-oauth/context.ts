import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Authenticated request context for a validated inbound OAuth access token.
 * Populated once per HTTP request by the Bearer middleware wrapper and read by
 * the per-tool scope enforcer inside the MCP tool handler.
 *
 * Because tokens are validated statelessly on every HTTP request (never cached
 * against a session), a token that expires or loses a scope cannot survive into
 * a later request: the next request is re-validated or rejected.
 */
export interface InboundAuthContext {
  subject: string;
  scopes: string[];
  clientId?: string;
  resource?: string;
  token: string;
}

const authStorage = new AsyncLocalStorage<InboundAuthContext | undefined>();

/** Runs `fn` with the authenticated request context bound for the current async flow. */
export function runWithAuthContext<T>(ctx: InboundAuthContext | undefined, fn: () => T): T {
  return authStorage.run(ctx, fn);
}

/** Returns the current request's authenticated context, if any (undefined = token mode / no OAuth). */
export function getCurrentAuthContext(): InboundAuthContext | undefined {
  return authStorage.getStore();
}