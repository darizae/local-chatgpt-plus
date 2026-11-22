/**
 * R2 hermetic matrix: inbound auth mode (token × OAuth) × MCP_SESSION_RECOVERY
 * (true × false) against real local fixture servers (dist/index.js).
 *
 * Covers session-ownership binding (SECURITY FOLLOW-UP on f9d9481):
 *   - F2 reproduction: OAuth + recovery-on stale-session recovery previously
 *     failed with an unauthenticated internal loopback (401 on warm-up init).
 *   - Authenticated recovery of a RECORDED stale session (same subject) via the
 *     internal loopback, preserving identity/scope, with zero unauth bypass.
 *   - Post-restart / unrecorded stale session: no recorded ownership -> fail
 *     closed with session-not-found instead of falsely claiming recovery.
 *   - Two-subject isolation: subject B cannot call or recover subject A's
 *     session (active or stale).
 *   - Scope downgrade: the owner with a narrower token is not granted the
 *     session (fail closed on downgrade).
 *   - Concurrent stale requests: owner recovers and runs the tool once, an
 *     attacker's request is rejected, and there is no duplicate side-effect
 *     replay from a second warm-up.
 *   - recovery-off always returns session-not-found (no loopback at all).
 *   - token mode baseline (recovery-on works, recovery-off returns 404).
 *   - Separate double-initialize reproduction: a second initialize on the same
 *     session id is rejected by the SDK (tunnel-probe fault, not fixed).
 *
 * Runs only against disposable fixture servers / temporary state dirs.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { getFreePorts } from "./free-port.mjs";
import { parseMcpResponseText } from "./mcp-test-response.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCE = "https://mcp.example.test/mcp";
const SUBJECT = "user-1";
const DEFAULT_SCOPES = ["mcp:connect", "files:read", "commands:execute"];

let passed = 0;
function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}

/** Minimal local issuer + JWKS for the real server's inbound OAuth discovery. */
async function startAs() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const pub = await exportJWK(publicKey);
  pub.kid = "r2-k1";
  pub.alg = "RS256";
  const signingKey = privateKey;
  let issuer;
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.get("/.well-known/oauth-authorization-server", (_req, res) =>
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      scopes_supported: ["mcp:connect", "files:read", "files:write", "commands:execute"],
    })
  );
  app.get("/jwks", (_req, res) => res.json({ keys: [pub] }));
  const srv = await listen(app);
  issuer = `http://127.0.0.1:${srv.address().port}`;
  const mint = async (subject, scopes) =>
    new SignJWT({ scope: scopes.join(" ") })
      .setProtectedHeader({ alg: "RS256", kid: "r2-k1" })
      .setSubject(subject)
      .setIssuer(issuer)
      .setAudience(RESOURCE)
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(signingKey);
  return { srv, issuer, mint };
}

async function waitForHealth(port, expectAuthMode, expectRecovery) {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) {
        const h = await res.json();
        if (h.authMode === expectAuthMode && String(h.sessionRecovery) === String(expectRecovery)) {
          return h;
        }
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not reach authMode=${expectAuthMode} recovery=${expectRecovery}`);
}

async function mcpPost(base, path, body, sessionId, headers = {}) {
  const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers };
  if (sessionId) h["mcp-session-id"] = sessionId;
  const res = await fetch(`${base}${path}`, { method: "POST", headers: h, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = parseMcpResponseText(text, res.headers.get("content-type") || "");
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

async function mcpDelete(base, path, sessionId, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "DELETE",
    headers: {
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-03-26",
      ...headers,
    },
  });
  return { status: res.status, text: await res.text() };
}

const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "r2-matrix", version: "1.0.0" },
  },
};

function callCommand(command) {
  return {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "run_command", arguments: { command } },
  };
}

async function initialize(base, path, headers) {
  const res = await mcpPost(base, path, INIT_BODY, null, headers);
  assert.equal(res.status, 200, `initialize HTTP ${res.status}: ${res.text.slice(0, 400)}`);
  const sid = res.headers.get("mcp-session-id");
  assert.ok(sid, "missing mcp-session-id after initialize");
  return { sid, json: res.json };
}

/**
 * Boot one fixture server. `mode` is "oauth" | "token"; `recovery` boolean;
 * `subjects` are the allowed OAuth subjects (default [SUBJECT]).
 * Returns { stop, base, mcpPath, mint, wsDir }.
 */
async function startServer({ mode, recovery, subjects = [SUBJECT] }) {
  const [port] = await getFreePorts(1);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "lcp-r2-"));
  const perm = path.join(scratch, "permissions.json");
  await fs.writeFile(perm, JSON.stringify({ version: 1, profile: "open" }), "utf-8");
  const wsDir = path.join(scratch, "ws");
  await fs.mkdir(wsDir, { recursive: true });

  const token = mode === "oauth" ? undefined : "r2-tok";
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    LOCAL_CODER_TUI: "off",
    LOCAL_CODER_ADMIN_ENABLED: "false",
    MCP_TOKEN: token || "",
    WORKSPACE_PATH: wsDir,
    PERMISSIONS_CONFIG: perm,
    INBOUND_AUTH_MODE: mode,
    MCP_SESSION_RECOVERY: String(recovery),
    MCP_JSON_RESPONSE: "false",
    MCP_SSE_KEEPALIVE_MS: "1000",
  };

  let as;
  if (mode === "oauth") {
    as = await startAs();
    env.INBOUND_OAUTH_ISSUER = as.issuer;
    env.INBOUND_OAUTH_RESOURCE_URI = RESOURCE;
    env.INBOUND_OAUTH_ALLOWED_SUBJECTS = subjects.join(";");
  }

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain stdout/stderr so the child never blocks on a full pipe buffer.
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});

  await waitForHealth(port, mode, recovery);

  const base = `http://127.0.0.1:${port}`;
  const mcpPath = mode === "oauth" ? "/mcp" : `/mcp/${token}`;

  return {
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (!child.killed) child.kill("SIGKILL");
      await closeServer(as?.srv);
      await fs.rm(scratch, { recursive: true, force: true });
    },
    base,
    mcpPath,
    wsDir,
    mint: (subject, scopes = DEFAULT_SCOPES) => as.mint(subject, scopes),
  };
}

/** Build OAuth Authorization headers for a subject/scopes via the fixture AS. */
async function auth(s, subject, scopes = DEFAULT_SCOPES) {
  return { Authorization: `Bearer ${await s.mint(subject, scopes)}` };
}

const PROTOCOL = { "mcp-protocol-version": "2025-03-26" };

// ---------------------------------------------------------------- matrix

const STALE = "00000000-0000-4000-8000-0000000000aa";

// OAuth × recovery-on — post-restart (unrecorded) stale must fail closed.
{
  const s = await startServer({ mode: "oauth", recovery: true });
  try {
    const A = await auth(s, SUBJECT);
    await initialize(s.base, s.mcpPath, A);

    // An unauthenticated stale request must be rejected before any recovery
    // (no OAuth bypass, even with recovery enabled).
    const unauth = await mcpPost(s.base, s.mcpPath, callCommand("echo x"), STALE, PROTOCOL);
    assert.equal(unauth.status, 401, `unauth stale request should 401, got ${unauth.status}`);

    // No recorded ownership (session id was never initialized in this process,
    // as after a restart) -> must not claim recovery; return session-not-found.
    const res = await mcpPost(s.base, s.mcpPath, callCommand("echo x"), STALE, {
      ...PROTOCOL,
      ...A,
    });
    assert.equal(res.status, 404, `unrecorded stale should 404, got ${res.status}: ${res.text.slice(0, 400)}`);
    assert.ok(String(res.json?.error?.message ?? "").includes("Session not found"), res.text.slice(0, 300));
    ok("OAuth + recovery-on: unrecorded (post-restart) stale session fails closed with 404 (no recovery)");
    ok("OAuth + recovery-on: unauthenticated stale request still 401 (no bypass)");
  } finally {
    await s.stop();
  }
}

// OAuth × recovery-on — a RECORDED stale session (same subject) recovers.
{
  const s = await startServer({ mode: "oauth", recovery: true });
  try {
    const A = await auth(s, SUBJECT);
    const init = await initialize(s.base, s.mcpPath, A);

    // DELETE closes the session but ownership stays recorded; it is stale.
    const del = await mcpDelete(s.base, s.mcpPath, init.sid, A);
    assert.ok([200, 202].includes(del.status), `DELETE should close session, got ${del.status}`);

    const rec = await mcpPost(s.base, s.mcpPath, callCommand("echo r2-recovery-ok"), init.sid, {
      ...PROTOCOL,
      ...A,
    });
    assert.equal(rec.status, 200, `recorded stale recovery should 200, got ${rec.status}: ${rec.text.slice(0, 500)}`);
    assert.ok(JSON.stringify(rec.json ?? rec.text).includes("r2-recovery-ok"), rec.text.slice(0, 400));
    ok("OAuth + recovery-on: recorded stale session (same subject) recovers via loopback");
  } finally {
    await s.stop();
  }
}

// OAuth × recovery-on — two-subject isolation (active + stale).
{
  const s = await startServer({ mode: "oauth", recovery: true, subjects: ["user-a", "user-b"] });
  try {
    const A = await auth(s, "user-a");
    const B = await auth(s, "user-b");
    const init = await initialize(s.base, s.mcpPath, A);

    // B cannot use A's active session.
    const bActive = await mcpPost(s.base, s.mcpPath, callCommand("echo x"), init.sid, { ...PROTOCOL, ...B });
    assert.equal(bActive.status, 404, `subject B active call should 404, got ${bActive.status}: ${bActive.text.slice(0, 300)}`);
    ok("two-subject: subject B cannot call subject A's active session (404)");

    // Stale: B still cannot recover; A can.
    await mcpDelete(s.base, s.mcpPath, init.sid, A);
    const bStale = await mcpPost(s.base, s.mcpPath, callCommand("echo x"), init.sid, { ...PROTOCOL, ...B });
    assert.equal(bStale.status, 404, `subject B stale call should 404, got ${bStale.status}`);
    const aRec = await mcpPost(s.base, s.mcpPath, callCommand("echo r2-owner-ok"), init.sid, { ...PROTOCOL, ...A });
    assert.equal(aRec.status, 200, `owner recovery should 200, got ${aRec.status}: ${aRec.text.slice(0, 400)}`);
    assert.ok(JSON.stringify(aRec.json ?? aRec.text).includes("r2-owner-ok"));
    ok("two-subject: subject B cannot recover subject A's stale session; A can (404 then 200)");
  } finally {
    await s.stop();
  }
}

// OAuth × recovery-on — scope downgrade fails closed.
{
  const s = await startServer({ mode: "oauth", recovery: true });
  try {
    const broad = await auth(s, SUBJECT, ["mcp:connect", "files:read", "files:write", "commands:execute"]);
    const init = await initialize(s.base, s.mcpPath, broad);

    const downgraded = await auth(s, SUBJECT, ["mcp:connect"]);
    const res = await mcpPost(s.base, s.mcpPath, callCommand("echo x"), init.sid, { ...PROTOCOL, ...downgraded });
    assert.equal(res.status, 404, `scope downgrade should fail closed, got ${res.status}: ${res.text.slice(0, 300)}`);
    ok("scope downgrade: owner with a narrower token is not granted the session (404)");
  } finally {
    await s.stop();
  }
}

// OAuth × recovery-on — concurrent stale requests: owner runs once, attacker
// rejected, no duplicate side-effect replay.
{
  const s = await startServer({ mode: "oauth", recovery: true, subjects: ["user-a", "user-b"] });
  try {
    const A = await auth(s, "user-a");
    const B = await auth(s, "user-b");
    const init = await initialize(s.base, s.mcpPath, A);
    await mcpDelete(s.base, s.mcpPath, init.sid, A);

    const counter = path.join(s.wsDir, "side-effect-counter.txt");
    const cmd = `echo tick >> ${counter}`;

    const [aRes, bRes] = await Promise.all([
      mcpPost(s.base, s.mcpPath, callCommand(cmd), init.sid, { ...PROTOCOL, ...A }),
      mcpPost(s.base, s.mcpPath, callCommand(cmd), init.sid, { ...PROTOCOL, ...B }),
    ]);

    assert.equal(aRes.status, 200, `owner concurrent recovery should 200, got ${aRes.status}: ${aRes.text.slice(0, 400)}`);
    assert.equal(bRes.status, 404, `attacker concurrent should 404, got ${bRes.status}`);

    const content = await fs.readFile(counter, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, `expected exactly one side effect, got ${lines.length}: ${content}`);
    ok("concurrent: owner recovers and the tool runs exactly once; attacker rejected (no duplicate replay)");
  } finally {
    await s.stop();
  }
}

// OAuth × recovery-off — no recovery loopback, session-not-found.
{
  const s = await startServer({ mode: "oauth", recovery: false });
  try {
    const A = await auth(s, SUBJECT);
    await initialize(s.base, s.mcpPath, A);
    const res = await mcpPost(s.base, s.mcpPath, callCommand("echo x"), STALE, { ...PROTOCOL, ...A });
    assert.equal(res.status, 404, `OAuth recovery-off should 404, got ${res.status}`);
    assert.ok(String(res.json?.error?.message ?? "").includes("Session not found"), res.text.slice(0, 300));
    ok("OAuth + recovery-off: stale session returns session-not-found (no recovery)");
  } finally {
    await s.stop();
  }
}

// Token × recovery-on — baseline must keep working.
{
  const s = await startServer({ mode: "token", recovery: true });
  try {
    await initialize(s.base, s.mcpPath, {});
    const res = await mcpPost(s.base, s.mcpPath, callCommand("echo r2-recovery-ok"), STALE, {});
    assert.equal(res.status, 200, `token recovery should 200, got ${res.status}: ${res.text.slice(0, 400)}`);
    assert.ok(JSON.stringify(res.json ?? res.text).includes("r2-recovery-ok"));
    ok("token + recovery-on: stale-session recovery still works (baseline preserved)");
  } finally {
    await s.stop();
  }
}

// Token × recovery-off — 404.
{
  const s = await startServer({ mode: "token", recovery: false });
  try {
    await initialize(s.base, s.mcpPath, {});
    const res = await mcpPost(s.base, s.mcpPath, callCommand("echo x"), STALE, {});
    assert.equal(res.status, 404, `token recovery-off should 404, got ${res.status}`);
    ok("token + recovery-off: stale session returns session-not-found");
  } finally {
    await s.stop();
  }
}

// Separate double-initialize reproduction: a second initialize on the same
// session id (what the recovery warm-up issues after the client has already
// initialized that session) is rejected by the SDK — the tunnel-probe fault.
{
  const s = await startServer({ mode: "oauth", recovery: true });
  try {
    const A = await auth(s, SUBJECT);
    const init = await initialize(s.base, s.mcpPath, A);
    const second = await mcpPost(s.base, s.mcpPath, INIT_BODY, init.sid, { ...PROTOCOL, ...A });
    // The SDK must not silently accept a re-initialize on an initialized session.
    assert.notEqual(second.status, 200, `second initialize should not succeed, got ${second.status}`);
    assert.ok(
      second.status >= 400,
      `expected a protocol/HTTP error for double initialize, got ${second.status}: ${second.text.slice(0, 300)}`
    );
    ok(`OAuth: double initialize on same session rejected (HTTP ${second.status})`);
  } finally {
    await s.stop();
  }
}

console.log(`\nOAuth session recovery matrix: ${passed} tests passed.`);