import { createRemoteJWKSet, jwtVerify, customFetch, type RemoteJWKSet } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

export interface TokenVerifierOptions {
  /** RFC 8414 issuer URL of the authorization server (https; localhost allowed for tests). */
  issuer: string;
  /** Canonical external MCP resource URI. Must appear in the token audience. */
  resource: string;
  /** JWKS URL (resolved from issuer metadata by the factory before construction). */
  jwksUri: string;
  /** Issuer metadata (RFC 8414) discovery timeout, ms. */
  discoveryTimeoutMs?: number;
  /** Signature algorithms accepted for access tokens. */
  allowedAlgorithms?: string[];
  /** Clock skew tolerance in seconds (default 30). */
  clockToleranceSeconds?: number;
  /** Allowlist of allowed `sub` values. Empty = accept any subject (not recommended). */
  allowedSubjects?: string[];
  /** Remote JWKS cache max age (ms). Default 5 minutes. */
  jwksCacheMaxAgeMs?: number;
  /** Remote JWKS unmatched-key refetch cooldown (ms). Default 30 s. */
  jwksCooldownMs?: number;
  /** Override "now" for tests (epoch seconds). */
  currentDateSeconds?: number;
  /** Custom fetch for metadata discovery (tests). */
  fetch?: typeof fetch;
}

export interface DiscoveredAsMetadata {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri: string;
  code_challenge_methods_supported?: string[];
  [key: string]: unknown;
}

const DEFAULT_ALGORITHMS = ["RS256", "ES256"];
const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_JWKS_CACHE_MAX_AGE_MS = 5 * 60_000;

function isAllowedIssuer(issuer: string): boolean {
  try {
    const url = new URL(issuer);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  } catch {
    return false;
  }
}

/** Normalizes issuer comparison per RFC 8414 (trailing slash is insignificant). */
function sameIssuer(a: string, b: string): boolean {
  try {
    return new URL(a).href.replace(/\/$/, "") === new URL(b).href.replace(/\/$/, "");
  } catch {
    return a === b;
  }
}

/**
 * Fetches and validates the RFC 8414 authorization-server metadata for an issuer.
 * Fail closed: missing authorization/token/jwks endpoints or a non-HTTPS issuer
 * is an error.
 */
export async function discoverAsMetadata(options: {
  issuer: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<DiscoveredAsMetadata> {
  const { issuer, timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS } = options;
  if (!isAllowedIssuer(issuer)) {
    throw new Error(`Inbound OAuth issuer must be HTTPS (or localhost for tests): ${issuer}`);
  }
  const url = new URL("/.well-known/oauth-authorization-server", issuer);
  const doFetch = options.fetch || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await doFetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) {
      throw new Error(`Authorization server metadata discovery failed: HTTP ${res.status} from ${url}`);
    }
    const metadata = (await res.json()) as DiscoveredAsMetadata;
    if (typeof metadata.issuer !== "string" || !sameIssuer(metadata.issuer, issuer)) {
      throw new Error(
        `Authorization server metadata issuer mismatch: got "${metadata.issuer}", expected "${issuer}"`
      );
    }
    for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
      if (typeof metadata[field] !== "string" || !metadata[field]) {
        throw new Error(`Authorization server metadata for ${issuer} has no ${field}`);
      }
    }
    return metadata;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves the JWKS URI for an issuer (discovery), used before constructing the verifier. */
export async function resolveJwksUri(options: {
  issuer: string;
  jwksUri?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  if (options.jwksUri) return options.jwksUri;
  const metadata = await discoverAsMetadata({
    issuer: options.issuer,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
  return metadata.jwks_uri;
}

/**
 * Validates MCP resource-server access tokens (JWT) against the issuer's JWKS.
 *
 * Every accepted token is checked for:
 *  - signature verifiable against a key in the issuer JWKS
 *  - signature algorithm in the allowlist
 *  - `iss` == configured issuer
 *  - `aud` == configured resource URI (RFC 8707 audience binding)
 *  - `exp` present and not passed, `nbf`/`iat` not in the future (clock tolerance)
 *  - `sub` in the configured subject allowlist (if any)
 *
 * Implements the SDK OAuthTokenVerifier interface so it plugs into
 * requireBearerAuth. ID tokens and upstream-provider access tokens are rejected
 * by the audience/issuer checks.
 */
export class McpTokenVerifier implements OAuthTokenVerifier {
  private readonly issuer: string;
  private readonly resource: string;
  private readonly allowedAlgorithms: string[];
  private readonly clockToleranceSeconds: number;
  private readonly allowedSubjects: string[];
  private readonly jwks: RemoteJWKSet;
  private readonly discoveryTimeoutMs: number;
  private readonly fetchImpl?: typeof fetch;
  private readonly currentDateSeconds?: number;
  private metadataPromise?: Promise<DiscoveredAsMetadata>;

  constructor(options: TokenVerifierOptions) {
    // Keep the issuer EXACTLY as configured. OAuth/JWT issuer comparison is
    // exact-string (RFC 8414 / MCP authorization do not normalize trailing
    // slashes, and Auth0 issues tokens whose `iss` carries a trailing slash).
    // Stripping the slash here made valid Auth0 tokens fail validation.
    this.issuer = options.issuer;
    this.resource = options.resource;
    // `??` alone is not enough: the env loader produces an empty array (not
    // undefined) when INBOUND_OAUTH_ALLOWED_ALGORITHMS is unset, which would
    // make jose reject every algorithm. Treat an empty/absent list as "use the
    // safe defaults (RS256/ES256)".
    this.allowedAlgorithms =
      Array.isArray(options.allowedAlgorithms) && options.allowedAlgorithms.length > 0
        ? options.allowedAlgorithms
        : DEFAULT_ALGORITHMS;
    this.clockToleranceSeconds = options.clockToleranceSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    this.allowedSubjects = options.allowedSubjects ?? [];
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    this.fetchImpl = options.fetch;
    this.currentDateSeconds = options.currentDateSeconds;
    const jwksOptions: Parameters<typeof createRemoteJWKSet>[1] = {
      cacheMaxAge: options.jwksCacheMaxAgeMs ?? DEFAULT_JWKS_CACHE_MAX_AGE_MS,
      cooldownDuration: options.jwksCooldownMs ?? 30_000,
      timeoutDuration: this.discoveryTimeoutMs,
    };
    if (this.fetchImpl) {
      // jose's customFetch signature differs slightly from fetch(); adapt it.
      jwksOptions[customFetch] = (url, reqInit) =>
        this.fetchImpl!(String(url), {
          ...reqInit,
          headers: new Headers(reqInit.headers as HeadersInit),
        });
    }
    this.jwks = createRemoteJWKSet(new URL(options.jwksUri), jwksOptions);
  }

  /** Public for tests / metadata advertisement. */
  async discoveryMetadata(): Promise<DiscoveredAsMetadata> {
    if (!this.metadataPromise) {
      this.metadataPromise = discoverAsMetadata({
        issuer: this.issuer,
        fetch: this.fetchImpl,
        timeoutMs: this.discoveryTimeoutMs,
      }).catch((err) => {
        this.metadataPromise = undefined;
        throw err;
      });
    }
    return this.metadataPromise;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (typeof token !== "string" || !token) {
      throw new InvalidTokenError("Missing access token");
    }
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.issuer,
      audience: this.resource,
      algorithms: this.allowedAlgorithms,
      clockTolerance: `${this.clockToleranceSeconds}s`,
      ...(this.currentDateSeconds !== undefined
        ? { currentDate: new Date(this.currentDateSeconds * 1000) }
        : {}),
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      throw new InvalidTokenError(`Access token rejected: ${message}`);
    });

    const nowSeconds =
      this.currentDateSeconds !== undefined
        ? this.currentDateSeconds
        : Math.floor(Date.now() / 1000);

    // Fail closed: a token without an expiration is not acceptable (jose only
    // validates `exp` when present; requiring it here keeps the resource server
    // strict for access tokens, which must always carry an expiry).
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      throw new InvalidTokenError("Access token is missing an expiration (exp)");
    }
    // Reject a token whose `iat` is in the future (beyond clock skew). jose
    // already enforces `nbf` and `exp`; `iat` is not checked by jose by default.
    if (typeof payload.iat === "number" && payload.iat > nowSeconds + this.clockToleranceSeconds) {
      throw new InvalidTokenError("Access token has an iat (issued-at) in the future");
    }

    const sub = typeof payload.sub === "string" ? payload.sub : "";
    if (this.allowedSubjects.length > 0 && !this.allowedSubjects.includes(sub)) {
      throw new InvalidTokenError(
        `Access token subject '${sub}' is not in the allowed account allowlist`
      );
    }

    const scopes = extractScopes(payload);
    const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    const resourceStr = aud.find((a): a is string => typeof a === "string" && a.length > 0);

    return {
      token,
      clientId: typeof payload.azp === "string" ? payload.azp : "",
      scopes,
      expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
      resource: resourceStr ? new URL(resourceStr) : undefined,
      extra: {
        subject: sub,
        issuer: payload.iss,
        audience: aud,
        client_id: payload.azp ?? undefined,
        token_type: payload.token_use ?? payload.typ ?? undefined,
      },
    };
  }
}

export function extractScopes(payload: Record<string, unknown>): string[] {
  const scopeClaim = payload.scope;
  if (typeof scopeClaim === "string" && scopeClaim) {
    return scopeClaim.split(/\s+/).filter(Boolean);
  }
  const scp = payload.scp;
  if (Array.isArray(scp)) {
    return scp.filter((item): item is string => typeof item === "string" && Boolean(item));
  }
  // Auth0 (with "Add Permissions in the Access Token" / RBAC) emits the granted
  // API permissions in a `permissions` claim. Treat those as scopes too so a
  // token carrying mcp:connect/files:read there satisfies per-tool checks.
  const perms = payload.permissions;
  if (Array.isArray(perms)) {
    return perms.filter((item): item is string => typeof item === "string" && Boolean(item));
  }
  return [];
}