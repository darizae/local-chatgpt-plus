/**
 * OMP Browser Relay v19 CDP action path (P1.13): drive an explicitly selected
 * already-open tab over the relay's raw `/cdp` websocket without ever bringing
 * the browser to the foreground or substituting a hidden/Vercel context.
 *
 * Protocol (verified against the installed `pi-coding-agent` relay
 * `server.ts`/`bridge.ts` v19.0.1 and the extension `background.js`):
 *   - `GET /json/list` -> opaque page-target ids (`PAGE<key>.<n>`); the relay
 *     itself is not token-gated for these two endpoints.
 *   - `WS /cdp` -> raw CDP. `Target.attachToTarget` answers `{sessionId}`;
 *     page commands carry that `sessionId` and are bridged to the extension's
 *     `chrome.debugger.sendCommand`. `Runtime.evaluate` returns Chrome's
 *     response `{ result: { result: RemoteObject, exceptionDetails? } }`.
 *   - The relay rejects any `Origin` on `/cdp`; Node's `WebSocket` client
 *     sends none, so it connects like a native CDP client.
 *
 * Safety: the client never navigates, never selects a tab implicitly, and never
 * talks to anything but the configured loopback relay. Every page action runs
 * inside a single evaluated expression whose first step re-checks the page's
 * live `location.href` against the exact bound URL, so a tab that navigated
 * between `/json/list` discovery and evaluation (a TOCTOU window) never
 * receives a click/fill/read and fails closed. The only code run on the page is
 * one of the fixed templates below; the sole interpolated values are
 * JSON-encoded primitives, never raw user strings, so no arbitrary expression
 * can be evaluated on the target page.
 */

import { normalizeTabUrl, HttpRelayTargetsTransport, assertLoopbackRelayOrigin, type RelayTarget, type RelayTargetsTransport } from "./omp-browser-relay.js";

/** The bounded, non-arbitrary operations this relay path can perform. */
export type RelayBrowserOp =
  | { kind: "getText" }
  | { kind: "getUrl" }
  | { kind: "getTitle" }
  | { kind: "click"; selector: string }
  | { kind: "fill"; selector: string; value: string };

export interface RelayBrowserOutcome {
  ok: boolean;
  text: string;
  error?: string;
  truncated?: boolean;
}

const CDP_REPLY_TIMEOUT_MS = 15_000;
// A hanging /cdp socket must not wait forever; bound the handshake.
const WS_HANDSHAKE_TIMEOUT_MS = 8_000;
const MAX_TEXT = 60_000;

// The navigation guard is prepended to every fixed template. `EXPECTED` is a
// JSON string literal of the exact normalized URL, never executable code. When
// the live page is no longer there, the operation fails closed on the page
// before running the body, so a navigated tab is never read or acted on.
const NAV_GUARD = (expected: string) =>
  `(()=>{if(location.href!==${expected})return{ok:false,error:"page navigated since binding",url:location.href};`;

function clickExpr(selector: string): string {
  return `const e=document.querySelector(${JSON.stringify(selector)});if(!e)return{ok:false,error:"selector not found"};e.click();return{ok:true};})()`;
}

function fillExpr(selector: string, value: string): string {
  return `const e=document.querySelector(${JSON.stringify(selector)});if(!e)return{ok:false,error:"selector not found"};e.value=${JSON.stringify(value)};e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return{ok:true};})()`;
}

function expressionFor(op: RelayBrowserOp, expectUrl: string): string {
  // normalizeTabUrl canonicalizes (default port, etc.) so it equals the
  // browser's own location.href spellings and never strips query/hash.
  const expected = JSON.stringify(normalizeTabUrl(expectUrl));
  switch (op.kind) {
    case "getText": return NAV_GUARD(expected) + `const d=document.body||document.documentElement;return d?d.innerText:"";})()`;
    case "getUrl": return NAV_GUARD(expected) + `return location.href;})()`;
    case "getTitle": return NAV_GUARD(expected) + `return document.title;})()`;
    case "click": return NAV_GUARD(expected) + clickExpr(op.selector);
    case "fill": return NAV_GUARD(expected) + fillExpr(op.selector, op.value);
  }
}

function parseEval(reply: unknown, op: RelayBrowserOp): RelayBrowserOutcome {
  // `command` resolves the relay's reply `result`, which for Runtime.evaluate is
  // Chrome's response body `{ result: RemoteObject, exceptionDetails? }`.
  if (!reply || typeof reply !== "object") {
    return { ok: false, text: "", error: "relay returned no Runtime.evaluate result" };
  }
  const record = reply as Record<string, unknown>;
  if ("exceptionDetails" in record && record.exceptionDetails != null) {
    return { ok: false, text: "", error: "page evaluation failed" };
  }
  const remote = record.result && typeof record.result === "object"
    ? (record.result as Record<string, unknown>) : undefined;
  const value = remote && "value" in remote ? remote.value : undefined;
  // Any object returned by the page is a structured result: the navigation
  // guard or a selector miss reports {ok:false,error}. Nothing else is valid.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (object.ok === false && typeof object.error === "string") {
      return { ok: false, text: "", error: object.error, truncated: false };
    }
    if ((op.kind === "click" || op.kind === "fill") && object.ok === true) {
      return { ok: true, text: "", truncated: false };
    }
    return { ok: false, text: "", error: "page returned an unexpected result", truncated: false };
  }
  if (op.kind === "click" || op.kind === "fill") {
    return { ok: false, text: "", error: "action reported failure on the page", truncated: false };
  }
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return { ok: true, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
}

/** Strictly revalidates the opaque target id against the live /json/list. */
export async function resolveRelayTarget(
  targets: RelayTargetsTransport,
  targetId: string,
  expectUrl: string,
): Promise<{ targetId: string; url: string; title: string }> {
  const live = await targets.listTargets();
  const target = live.find((t) => t.targetId === targetId);
  if (!target) {
    throw new Error(`relay target ${targetId} is no longer open; re-select an existing tab`);
  }
  if (expectUrl && normalizeTabUrl(target.url) !== normalizeTabUrl(expectUrl)) {
    throw new Error("target URL changed since selection; re-select the tab (never navigate or reuse a moved tab)");
  }
  return { targetId, url: target.url, title: target.title };
}

/**
 * Minimal raw-CDP client over the relay's `/cdp` websocket. One short-lived
 * connection per action: attach by opaque target id, run one bounded
 * expression, close. Never reused across actions, so no stale session drift.
 */
export class RelayCdpClient {
  private readonly wsUrl: string;
  private readonly targets: RelayTargetsTransport;
  private readonly handshakeTimeoutMs: number;

  constructor(
    base: string,
    targets?: RelayTargetsTransport,
    opts?: { handshakeTimeoutMs?: number },
  ) {
    // Fails closed on any non-loopback / privileged / credentialed origin so an
    // injectable mock target transport can never reroute the websocket off-host.
    assertLoopbackRelayOrigin(base);
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/cdp";
    url.search = "";
    this.wsUrl = url.href;
    this.targets = targets ?? new HttpRelayTargetsTransport(base);
    this.handshakeTimeoutMs = opts?.handshakeTimeoutMs ?? WS_HANDSHAKE_TIMEOUT_MS;
  }

  /** Read-only discovery of the relay's attachable page targets (for selection). */
  async listTargets(): Promise<RelayTarget[]> {
    return this.targets.listTargets();
  }

  /**
   * Revalidate the exact tab URL against /json/list, then run one bounded
   * operation on that tab. The evaluated expression itself re-checks the live
   * in-page `location.href` against the same URL immediately before acting, so
   * a tab that navigated during the attach<->evaluate window (TOCTOU) receives
   * no click/fill/read and fails closed. Never caused by a stale session.
   */
  async run(targetId: string, expectUrl: string, op: RelayBrowserOp): Promise<RelayBrowserOutcome> {
    await resolveRelayTarget(this.targets, targetId, expectUrl);
    const ws = new WebSocket(this.wsUrl);
    try {
      await openSocket(ws, this.handshakeTimeoutMs);
      const attach = await command(ws, 1, {
        method: "Target.attachToTarget",
        params: { targetId, flatten: true },
      });
      let sessionId: string | undefined;
      if (attach && typeof attach === "object" && "sessionId" in attach && typeof attach.sessionId === "string") {
        sessionId = attach.sessionId;
      }
      if (!sessionId) {
        throw new Error(`relay returned no CDP session for target ${targetId}`);
      }
      const evalReply = await command(ws, 2, {
        sessionId,
        method: "Runtime.evaluate",
        params: { expression: expressionFor(op, expectUrl), returnByValue: true },
      });
      return parseEval(evalReply, op);
    } finally {
      try { ws.close(); } catch { /* already closed */ }
    }
  }
}

function openSocket(ws: WebSocket, timeoutMs: number): Promise<void> {
  // Executor form is required: the ES2022 lib in tsconfig does not declare
  // Promise.withResolvers even though the Node 26 runtime provides it.
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      if (err) {
        try { ws.close(); } catch { /* never connected */ }
        reject(err);
      } else {
        resolve();
      }
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error("could not connect to the OMP relay /cdp websocket"));
    // Bound the handshake: a relay that accepts TCP but never completes the
    // upgrade must fail closed instead of hanging the caller forever. Settle
    // before closing so undici's terminating `error` event cannot rewrite the
    // verdict to a generic connect failure.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      try { ws.close(); } catch { /* not ready */ }
      reject(new Error(`timed out connecting to the OMP relay /cdp websocket after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}

function command(
  ws: WebSocket,
  id: number,
  payload: Record<string, unknown>,
  timeoutMs = CDP_REPLY_TIMEOUT_MS,
): Promise<unknown> {
  // Executor form: same ES2022-lib reason as openSocket.
  return new Promise((resolve, reject) => {
  const onMessage = (event: MessageEvent) => {
    let data: unknown;
    try { data = JSON.parse(String(event.data)); } catch { return; }
    if (!data || typeof data !== "object") return;
    const record = data as Record<string, unknown>;
    if (record.id !== id) return; // ignore events and other replies
    clearTimeout(timer);
    ws.removeEventListener("message", onMessage);
    if ("error" in record && record.error && typeof record.error === "object") {
      const message = (record.error as { message?: unknown }).message;
      reject(new Error(`CDP ${payload.method} failed: ${typeof message === "string" ? message : "unknown error"}`));
    } else {
      resolve(record.result);
    }
  };
  const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error(`CDP ${payload.method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.addEventListener("message", onMessage);
    try {
      ws.send(JSON.stringify({ id, ...payload }));
    } catch (error) {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      reject(error instanceof Error ? error : new Error("CDP websocket send failed"));
    }
  });
}