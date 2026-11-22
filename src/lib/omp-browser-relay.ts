/**
 * OMP Browser Relay v19 integration (P1.13): drive an explicitly selected
 * already-open tab in the background instead of Vercel's agent-browser (which
 * takes over the user's browser window).
 *
 * Protocol ground truth (verified 2026-11-21 against the installed OMP Browser
 * Relay extension at ~/.omp/browser-relay/extension/background.js v19.0.1 and
 * the pi-coding-agent relay `server.ts`/`bridge.ts` sources):
 *   - The real relay is the `omp browser-relay` daemon (binds 127.0.0.1, port
 *     default 9224). It impersonates Chrome's CDP discovery endpoint:
 *       GET /json/version -> 503 until the extension is connected, then
 *                            Chrome-like version with webSocketDebuggerUrl.
 *       GET /json/list    -> [{id:"PAGE<key>.<n>", type:"page", title, url,
 *                             active:"true", discarded:"false"}] — opaque
 *                             page-target ids, not numeric tab ids.
 *       WS  /cdp          -> raw CDP (puppeteer attaches here); a browser
 *                            Origin header is rejected with 403.
 *       WS  /ext          -> the Chrome extension (token-gated).
 *   - The agent attaches to a page target by its opaque id over /cdp
 *     (Target.attachToTarget, then per-session commands); the relay bridges
 *     those to the extension's chrome.debugger over {op:"send",tabId,...} RPC.
 *
 * Scope of THIS module: real, read-only target listing (GET /json/list) and
 * explicit, fail-closed target binding. Live driving over /cdp is deliberately
 * NOT enabled: it needs a running relay + a connected real extension + the
 * user's browser, which P1.13 keeps blocked pending user-safe validation (see
 * the computer-use relayGate). No silent Vercel/desktop fallback is ever made.
 */

/** A page target as the real relay reports it in GET /json/list. */
export type RelayTarget = {
  targetId: string;
  url: string;
  title: string;
  active: boolean;
};

export type TabRequest =
  | { kind: "byUrl"; url: string }
  | { kind: "byTargetId"; targetId: string };

export type TabMatch =
  | { status: "matched"; target: RelayTarget; reason: string }
  | { status: "ambiguous"; matches: RelayTarget[]; reason: string }
  | { status: "missing"; reason: string };

export type RelayRoute =
  | { adapter: "omp-relay"; target: RelayTarget; reason: string }
  | { adapter: "none"; reason: string };

/** Canonicalize URL syntax without discarding query or hash route identity. */
export function normalizeTabUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return url.href;
  } catch {
    return raw;
  }
}

/**
 * Match an explicitly requested already-open target using canonical URL
 * equality, including query parameters and fragment routes. A `byTargetId`
 * request matches only that exact opaque target id. Multiple matches are
 * ambiguous and never resolved implicitly; a redirect requires re-selection.
 */
export function matchTab(targets: RelayTarget[], request: TabRequest): TabMatch {
  if (request.kind === "byTargetId") {
    const target = targets.find((t) => t.targetId === request.targetId);
    return target
      ? { status: "matched", target, reason: "exact target id" }
      : { status: "missing", reason: `no open target with id ${request.targetId}` };
  }
  const target = normalizeTabUrl(request.url);
  const exact = targets.filter((t) => normalizeTabUrl(t.url) === target);
  if (exact.length === 0) {
    // Do not put owner-supplied URLs (which may contain tokens) into logs/errors.
    return { status: "missing", reason: "no already-open tab matches the requested URL" };
  }
  if (exact.length > 1) {
    return {
      status: "ambiguous",
      matches: exact,
      reason: `${exact.length} open tabs match ${target}; specify the exact target`,
    };
  }
  return { status: "matched", target: exact[0], reason: "matched an already-open tab by URL" };
}

/**
 * Decide which browser adapter to use for a request. When the owner supplies an
 * explicit already-open target and the relay is configured, the relay is the
 * only acceptable surface: an unavailable/missing/ambiguous target fails closed
 * (adapter "none") rather than silently dropping to Vercel or desktop.
 */
export function routeBrowserRequest(opts: {
  relayConfigured: boolean;
  relayTargets: RelayTarget[];
  request: TabRequest | null;
}): RelayRoute {
  if (!opts.relayConfigured) {
    // No relay configured: this is the default path, unchanged.
    return { adapter: "none", reason: "omp-relay not configured" };
  }
  if (opts.request === null) {
    // Owner did not name an already-open tab; the relay is not a silent default.
    return { adapter: "none", reason: "no explicit already-open tab requested" };
  }
  const matched = matchTab(opts.relayTargets, opts.request);
  if (matched.status === "matched") {
    return { adapter: "omp-relay", target: matched.target, reason: matched.reason };
  }
  // Fail closed. Never invent a substitute surface.
  return { adapter: "none", reason: matched.reason };
}

/**
 * Reject any relay base that is not a plain loopback HTTP origin with an
 * explicit port. Both target discovery and the raw /cdp websocket must stay
 * on localhost: a forged/injectable base must never reach an off-host endpoint
 * (the relay carries the owner's full browser). Returns the validated URL.
 */
export function assertLoopbackRelayOrigin(base: string): URL {
  const url = new URL(base);
  if (url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase()) ||
      !url.port || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/") {
    throw new Error("OMP relay URL must be a plain loopback HTTP origin with an explicit port");
  }
  return url;
}

/** Read-only target listing + explicit binding against the real relay. */
export interface RelayTargetsTransport {
  listTargets(): Promise<RelayTarget[]>;
}

export class BrowserRelayClient {
  constructor(
    private readonly base: string,
    private readonly transport: RelayTargetsTransport,
  ) {}

  baseUrl(): string {
    return this.base;
  }

  listTargets(): Promise<RelayTarget[]> {
    return this.transport.listTargets();
  }
}

/**
 * Real transport: GET /json/list against the `omp browser-relay` daemon. Reads
 * only non-credential page metadata (id, url, title, active); no cookies or
 * session storage. Live CDP driving over /cdp is not implemented here.
 */
export class HttpRelayTargetsTransport implements RelayTargetsTransport {
  constructor(
    private readonly base: string,
    private readonly token: string = "",
  ) {
    // The relay carries privileged browser metadata; never send its token to
    // a remote host, non-HTTP transport, or URL containing credentials.
    assertLoopbackRelayOrigin(base);
  }

  async listTargets(): Promise<RelayTarget[]> {
    const url = new URL("/json/list", this.base);
    if (this.token) url.searchParams.set("token", this.token);
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.status === 503) throw new Error("relay is up but no extension is connected (GET /json/list 503)");
    if (!res.ok) throw new Error(`relay /json/list returned HTTP ${res.status}`);
    const body = (await res.json()) as Array<Record<string, string>>;
    if (!Array.isArray(body)) return [];
    return body
      .filter((t) => typeof t.id === "string" && t.id.length > 0)
      .map((t) => ({
        targetId: t.id as string,
        url: t.url ?? "",
        title: t.title ?? "",
        active: String(t.active) === "true",
      }));
  }
}

/** In-memory transport for hermetic fixtures and fail-closed validation. */
export class MockRelayTargetsTransport implements RelayTargetsTransport {
  constructor(private targets: RelayTarget[]) {}

  setTargets(targets: RelayTarget[]): void {
    this.targets = targets;
  }

  async listTargets(): Promise<RelayTarget[]> {
    return this.targets;
  }
}