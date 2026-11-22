import express from "express";
import type { RequestHandler, Router } from "express";
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  ALL_SCOPES,
  SCOPES,
  TOOL_SCOPE_OVERRIDES,
  requiredScopeForKind,
  type Scope,
  type ToolKind,
} from "./scopes.js";
import { McpTokenVerifier, resolveJwksUri, type DiscoveredAsMetadata } from "./verifier.js";
import {
  runWithAuthContext,
  getCurrentAuthContext,
  type InboundAuthContext,
} from "./context.js";

export type InboundAuthMode = "token" | "oauth";

export interface InboundAuthOptions {
  mode: InboundAuthMode;
  /** RFC 8414 issuer URL (required in oauth mode). */
  issuer?: string;
  /** Canonical external MCP resource URI (required in oauth mode). */
  resourceUri?: string;
  /** Allowed token subjects (semicolon-separated; required in oauth mode, fail closed). */
  allowedSubjects?: string[];
  /** JWKS URI override. */
  jwksUri?: string;
  allowedAlgorithms?: string[];
  clockToleranceSeconds?: number;
  jwksCacheMaxAgeMs?: number;
  jwksCooldownMs?: number;
  discoveryTimeoutMs?: number;
  resourceName?: string;
  /** Custom fetch for metadata discovery (tests). */
  fetch?: typeof fetch;
}

export interface InboundAuth {
  mode: InboundAuthMode;
  isOauthMode: boolean;
  /** Express middleware that enforces a valid, audience-bound Bearer token + base scope. */
  requireAuth: RequestHandler;
  /** RFC 9728 protected-resource + RFC 8414 metadata router (oauth mode only). */
  metadataRouter: Router | undefined;
  /** Authoritative per-tool scope check. No-op in token mode (baseline). */
  enforceToolScope(toolName: string, kind: ToolKind): void;
  /** Current request's authenticated context (undefined in token mode). */
  currentContext(): InboundAuthContext | undefined;
  /** Run fn with the authenticated request context bound. */
  runWithContext<T>(auth: AuthInfo | undefined, fn: () => T): T;
  verifier?: McpTokenVerifier;
  resourceUri?: string;
  issuer?: string;
  discoveredMetadata?: DiscoveredAsMetadata;
  scopesSupported: readonly Scope[];
}

function parseMode(raw: string | undefined): InboundAuthMode {
  const value = (raw || "token").trim().toLowerCase();
  if (value === "oauth") return "oauth";
  if (value === "token") return "token";
  throw new Error(`Invalid INBOUND_AUTH_MODE '${raw}'; expected 'token' or 'oauth'`);
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function requiredEnv(name: string, value: string | undefined): string {
  if (!value || !value.trim()) {
    throw new Error(
      `Inbound OAuth (INBOUND_AUTH_MODE=oauth) requires ${name} to be set. ` +
        "Failing closed: refusing to start an unauthenticated MCP server."
    );
  }
  return value.trim();
}

/** Reads configuration from the process environment. Throws on invalid oauth config (fail closed). */
export function inboundAuthOptionsFromEnv(): InboundAuthOptions {
  const mode = parseMode(process.env.INBOUND_AUTH_MODE);
  if (mode === "token") return { mode };
  return {
    mode,
    issuer: process.env.INBOUND_OAUTH_ISSUER?.trim() || undefined,
    resourceUri: process.env.INBOUND_OAUTH_RESOURCE_URI?.trim() || undefined,
    allowedSubjects: splitList(process.env.INBOUND_OAUTH_ALLOWED_SUBJECTS),
    jwksUri: process.env.INBOUND_OAUTH_JWKS_URI?.trim() || undefined,
    allowedAlgorithms: splitList(process.env.INBOUND_OAUTH_ALLOWED_ALGORITHMS),
    clockToleranceSeconds: envPositiveInt(process.env.INBOUND_OAUTH_CLOCK_SKEW_SECONDS),
    jwksCacheMaxAgeMs: envPositiveInt(process.env.INBOUND_OAUTH_JWKS_CACHE_TTL_MS),
    discoveryTimeoutMs: envPositiveInt(process.env.INBOUND_OAUTH_DISCOVERY_TIMEOUT_MS),
    resourceName: process.env.INBOUND_OAUTH_RESOURCE_NAME?.trim() || undefined,
  };
}

function envPositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Builds the inbound OAuth resource-server integration.
 *
 * oauth mode performs AS metadata discovery up front and fails closed on any
 * missing/invalid configuration or unreachable issuer. token mode is the exact
 * existing MCP_TOKEN URL-path baseline (no OAuth routes, no-op middleware).
 */
export async function createInboundAuth(options: InboundAuthOptions): Promise<InboundAuth> {
  if (options.mode === "token") {
    return {
      mode: "token",
      isOauthMode: false,
      requireAuth: (_req, _res, next) => next(),
      metadataRouter: undefined,
      enforceToolScope() {
        /* baseline: no OAuth scope enforcement in token mode */
      },
      currentContext: () => undefined,
      runWithContext: (_auth, fn) => fn(),
      scopesSupported: ALL_SCOPES,
    };
  }

  const issuer = requiredEnv("INBOUND_OAUTH_ISSUER", options.issuer);
  const resourceUri = requiredEnv("INBOUND_OAUTH_RESOURCE_URI", options.resourceUri);
  const allowedSubjects = options.allowedSubjects ?? [];
  if (allowedSubjects.length === 0) {
    throw new Error(
      "Inbound OAuth (INBOUND_AUTH_MODE=oauth) requires INBOUND_OAUTH_ALLOWED_SUBJECTS " +
        "(the intended account subject). Failing closed to avoid accepting any user."
    );
  }
  let resourceUrl: URL;
  try {
    resourceUrl = new URL(resourceUri);
  } catch {
    throw new Error(`INBOUND_OAUTH_RESOURCE_URI is not a valid URL: ${resourceUri}`);
  }
  if (resourceUrl.hash) {
    throw new Error("INBOUND_OAUTH_RESOURCE_URI must not contain a fragment");
  }

  const jwksUri = await resolveJwksUri({
    issuer,
    jwksUri: options.jwksUri,
    fetch: options.fetch,
    timeoutMs: options.discoveryTimeoutMs,
  });

  const verifier = new McpTokenVerifier({
    issuer,
    resource: resourceUrl.href,
    jwksUri,
    allowedAlgorithms: options.allowedAlgorithms,
    clockToleranceSeconds: options.clockToleranceSeconds,
    allowedSubjects,
    jwksCacheMaxAgeMs: options.jwksCacheMaxAgeMs,
    jwksCooldownMs: options.jwksCooldownMs,
    discoveryTimeoutMs: options.discoveryTimeoutMs,
    fetch: options.fetch,
  });

  const discoveredMetadata = await verifier.discoveryMetadata();

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const requireAuth = requireBearerAuth({
    verifier,
    requiredScopes: [SCOPES.connect],
    resourceMetadataUrl,
    expectedResource: resourceUrl,
  });

  // The discovered RFC 8414 document is structurally compatible with the SDK's
  // OAuthMetadata (a superset with extra keys such as jwks_uri); the cast bridges
  // the two external/metadata types at the SDK boundary.
  const metadataRouter = mcpAuthMetadataRouter({
    oauthMetadata: discoveredMetadata as unknown as OAuthMetadata,
    resourceServerUrl: resourceUrl,
    scopesSupported: ALL_SCOPES as unknown as string[],
    resourceName: options.resourceName ?? "Local ChatGPT Plus MCP",
  });

  // The MCP SDK serves RFC 9728 protected-resource metadata at a path derived
  // from the resource URI (`/.well-known/oauth-protected-resource<path>`). The
  // OpenAI Secure MCP Tunnel probes discovery at the fixed, root-relative path
  // `/.well-known/oauth-protected-resource/mcp` (its documented minimum
  // contract). With a deep resource URI (e.g. `https://api.openai.com/v1/mcp/<id>`)
  // those paths diverge, so the tunnel readiness probe fails. Serve the same
  // protected-resource metadata at the tunnel's fixed path as well.
  const protectedResourceMetadata = {
    resource: resourceUrl.href,
    authorization_servers: [discoveredMetadata.issuer],
    scopes_supported: ALL_SCOPES as string[],
    resource_name: options.resourceName ?? "Local ChatGPT Plus MCP",
  };
  const tunnelDiscoveryRouter = express.Router();
  tunnelDiscoveryRouter.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.status(200).json(protectedResourceMetadata);
  });
  const combinedMetadataRouter = express.Router();
  combinedMetadataRouter.use(metadataRouter);
  combinedMetadataRouter.use(tunnelDiscoveryRouter);

  const base: Omit<InboundAuth, "enforceToolScope" | "currentContext" | "runWithContext"> = {
    mode: "oauth",
    isOauthMode: true,
    requireAuth,
    metadataRouter: combinedMetadataRouter,
    verifier,
    resourceUri: resourceUrl.href,
    issuer,
    discoveredMetadata,
    scopesSupported: ALL_SCOPES,
  };

  return {
    ...base,
    enforceToolScope(toolName, kind) {
      const auth = getCurrentAuthContext();
      if (!auth) return; // token mode / not reached with OAuth
      const required: Scope =
        TOOL_SCOPE_OVERRIDES[toolName] ?? requiredScopeForKind(kind);
      if (!auth.scopes.includes(required)) {
        throw new Error(
          `Insufficient scope: tool '${toolName}' requires '${required}' but the token grants [${auth.scopes.join(", ")}]`
        );
      }
    },
    currentContext: () => getCurrentAuthContext(),
    runWithContext: (auth, fn) => runWithAuthContext(toInboundContext(auth), fn),
  };
}

export function toInboundContext(auth: AuthInfo | undefined): InboundAuthContext | undefined {
  if (!auth) return undefined;
  return {
    subject: String((auth.extra?.subject as string | undefined) ?? auth.clientId ?? ""),
    scopes: auth.scopes,
    clientId: auth.clientId || undefined,
    resource: auth.resource ? auth.resource.href : undefined,
    token: auth.token,
  };
}

export { SCOPES, ALL_SCOPES, TOOL_SCOPE_OVERRIDES, requiredScopeForKind } from "./scopes.js";
export { McpTokenVerifier, discoverAsMetadata, resolveJwksUri, extractScopes } from "./verifier.js";
export { getCurrentAuthContext, runWithAuthContext, type InboundAuthContext } from "./context.js";