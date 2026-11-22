// Inbound OAuth 2.1 resource-server integration tests.
// Runs against a local test authorization server (RFC 8414 metadata + JWKS +
// PKCE S256 authorize/token) and the built resource-server module, mirroring an
// external identity provider behind a Secure MCP Tunnel.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createInboundAuth, inboundAuthOptionsFromEnv, SCOPES } from "../dist/lib/inbound-oauth/index.js";

const ISSUER = "https://idp.example.test";
const RESOURCE = "https://mcp.example.test/mcp";
const CLIENT_ID = "chatgpt-client-test";
const CALLBACK = "https://chatgpt.com/aip/plugin/mcp/oauth/callback";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`OK  ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exitCode = 1;
    throw err;
  }
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function sha256Base64url(input) {
  return base64url(createHash("sha256").update(input).digest());
}

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}

async function request(port, path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body,
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json, location: res.headers.get("location") };
}

/** Minimal test authorization server. */
class TestAuthorizationServer {
  constructor() {
    this.signingKey = null;
    this.keys = []; // [{ kid, privateJwk }] — the current JWKS
    this.pendingCodes = new Map(); // code -> { challenge, clientId, scopes, resource }
    this.currentKid = null;
    this.consent = "allow"; // or "deny"
  }

  async init() {
    await this.rotate();
  }

  async rotate() {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const kid = `kid-${this.keys.length + 1}`;
    const privateJwk = await exportJWK(privateKey);
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = kid;
    publicJwk.alg = "RS256";
    privateJwk.kid = kid;
    privateJwk.alg = "RS256";
    this.keys = [{ kid, privateJwk, publicJwk }];
    this.currentKid = kid;
    this.signingKey = privateKey;
    return kid;
  }

  app() {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.get("/.well-known/oauth-authorization-server", (_req, res) => {
      res.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        scopes_supported: Object.values(SCOPES),
      });
    });
    app.get("/jwks", (_req, res) => {
      res.json({ keys: this.keys.map((k) => k.publicJwk) });
    });
    app.get("/authorize", (req, res) => {
      const { redirect_uri, code_challenge, state, scope, resource } = req.query;
      if (!redirect_uri || redirect_uri !== CALLBACK) {
        return res.redirect(`${CALLBACK}?error=invalid_request`);
      }
      if (!code_challenge) {
        return res.redirect(`${CALLBACK}?error=invalid_request&state=${state || ""}`);
      }
      if (this.consent === "deny") {
        return res.redirect(`${CALLBACK}?error=access_denied&state=${state || ""}`);
      }
      const code = `code-${randomBytes(8).toString("hex")}`;
      this.pendingCodes.set(code, {
        challenge: String(code_challenge),
        clientId: CLIENT_ID,
        scopes: (scope ? String(scope).split(" ") : []).filter(Boolean),
        resource: resource ? String(resource) : RESOURCE,
      });
      const q = new URLSearchParams({ code, state: state || "" });
      return res.redirect(`${CALLBACK}?${q.toString()}`);
    });
    app.post("/token", async (req, res) => {
      const body = new URLSearchParams(req.body || "");
      const grant = body.get("grant_type");
      if (grant === "authorization_code") {
        const code = body.get("code");
        const verifier = body.get("code_verifier");
        const redirect_uri = body.get("redirect_uri");
        const pending = this.pendingCodes.get(code || "");
        if (!pending) {
          return res.status(400).json({ error: "invalid_grant", error_description: "unknown code" });
        }
        if (!verifier || sha256Base64url(verifier) !== pending.challenge) {
          return res.status(400).json({ error: "invalid_grant", error_description: "PKCE code_verifier mismatch" });
        }
        this.pendingCodes.delete(code);
        const accessToken = await this.mintToken({
          sub: "user-1",
          scopes: pending.scopes,
          resource: pending.resource,
          exp: Math.floor(Date.now() / 1000) + 3600,
        });
        return res.json({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: pending.scopes.join(" "),
          refresh_token: "refresh-1",
        });
      }
      if (grant === "refresh_token") {
        const refresh = body.get("refresh_token");
        if (refresh !== "refresh-1") {
          return res.status(400).json({ error: "invalid_grant", error_description: "bad refresh token" });
        }
        const accessToken = await this.mintToken({
          sub: "user-1",
          scopes: Object.values(SCOPES),
          resource: RESOURCE,
          exp: Math.floor(Date.now() / 1000) + 3600,
        });
        return res.json({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: Object.values(SCOPES).join(" "),
          refresh_token: "refresh-2",
        });
      }
      return res.status(400).json({ error: "unsupported_grant_type" });
    });
    return app;
  }

  async mintToken({ sub, scopes, resource, exp, nbf, iat, iss = ISSUER, aud = resource, alg = "RS256", kid = this.currentKid }) {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({ scope: scopes.join(" "), azp: CLIENT_ID })
      .setProtectedHeader({ alg, kid })
      .setSubject(sub)
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt(iat ?? now)
      .setExpirationTime(exp)
      .sign(this.signingKey);
    return jwt;
  }
}

/** Builds the resource-server app under test. */
async function buildResourceApp(asPort, issuer = ISSUER, resourceUri = RESOURCE) {
  // Route the fake public issuer to the local test AS, simulating a real
  // publicly-reachable identity provider behind the tunnel. `issuer` may carry
  // a trailing slash (Auth0-style); the replace still matches the host prefix.
  const routeToAs = async (url, init) =>
    fetch(String(url).replace(ISSUER, `http://127.0.0.1:${asPort}`), init);
  const inboundAuth = await createInboundAuth({
    mode: "oauth",
    issuer,
    resourceUri,
    allowedSubjects: ["user-1"],
    jwksCacheMaxAgeMs: 60,
    jwksCooldownMs: 25,
    discoveryTimeoutMs: 3000,
    fetch: routeToAs,
  });
  const app = express();
  app.use(express.json());
  if (inboundAuth.metadataRouter) app.use(inboundAuth.metadataRouter);
  app.get("/mcp", inboundAuth.requireAuth, (req, res) => {
    res.json({ ok: true, subject: req.auth?.extra?.subject, scopes: req.auth?.scopes });
  });
  app.post("/mcp/call", inboundAuth.requireAuth, (req, res) => {
    inboundAuth.runWithContext(req.auth, () => {
      try {
        inboundAuth.enforceToolScope(req.body?.tool, req.body?.kind);
        res.json({ ok: true });
      } catch (err) {
        res.status(403).json({ ok: false, error: err.message });
      }
    });
  });
  return { app, inboundAuth };
}

let asServer;
let resourcePort;

async function setup() {
  const as = new TestAuthorizationServer();
  await as.init();
  asServer = await listen(as.app());
  const resource = await buildResourceApp(asServer.address().port);
  const resourceServer = await listen(resource.app);
  resourcePort = resourceServer.address().port;
  return { as, resource, resourceServer };
}

// ---------------------------------------------------------------- tests

let ctx;
await test("setup: test AS + resource server", async () => {
  ctx = await setup();
  assert.ok(ctx.as);
});

await test("discovery: protected-resource metadata (RFC 9728) served through the MCP path", async () => {
  const { status, json } = await request(resourcePort, "/.well-known/oauth-protected-resource/mcp");
  assert.equal(status, 200);
  assert.equal(json.resource, RESOURCE);
  assert.deepEqual(json.authorization_servers, [ISSUER]);
  assert.ok(json.scopes_supported.includes(SCOPES.connect));
  assert.ok(json.scopes_supported.includes(SCOPES.commandsExecute));
  assert.equal(json.resource_name, "Local ChatGPT Plus MCP");
});

await test("discovery: authorization-server metadata (RFC 8414) advertises S256 + endpoints", async () => {
  const { status, json } = await request(resourcePort, "/.well-known/oauth-authorization-server");
  assert.equal(status, 200);
  assert.equal(json.issuer, ISSUER);
  assert.ok(json.code_challenge_methods_supported.includes("S256"));
  assert.ok(json.authorization_endpoint);
  assert.ok(json.token_endpoint);
  assert.ok(json.jwks_uri);
});

await test("discovery: deep resource URI still serves PRM at the tunnel fixed path /mcp", async () => {
  // The OpenAI Secure MCP Tunnel probes discovery at the fixed, root-relative
  // path /.well-known/oauth-protected-resource/mcp regardless of the resource
  // URI's path. With a deep resource URI (e.g. https://api.openai.com/v1/mcp/<id>)
  // the SDK's derived path would differ, so the server must also serve the same
  // metadata at the fixed path (regression for the tunnel readiness probe).
  const deepResource = await buildResourceApp(
    asServer.address().port,
    ISSUER,
    "https://api.openai.com/v1/mcp/tunnel_abc"
  );
  const deepServer = await listen(deepResource.app);
  const port = deepServer.address().port;
  try {
    const fixed = await request(port, "/.well-known/oauth-protected-resource/mcp");
    assert.equal(fixed.status, 200);
    assert.equal(fixed.json.resource, "https://api.openai.com/v1/mcp/tunnel_abc");
    assert.deepEqual(fixed.json.authorization_servers, [ISSUER]);
    // Derived path (SDK) must also still serve the metadata.
    const derived = await request(
      port,
      "/.well-known/oauth-protected-resource/v1/mcp/tunnel_abc"
    );
    assert.equal(derived.status, 200);
    assert.equal(derived.json.resource, "https://api.openai.com/v1/mcp/tunnel_abc");
  } finally {
    await closeServer(deepServer);
  }
});

await test("bearer: valid token accepted and subject/scopes bound", async () => {
  const token = await ctx.as.mintToken({
    sub: "user-1",
    scopes: Object.values(SCOPES),
    resource: RESOURCE,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const { status, json } = await request(resourcePort, "/mcp", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.subject, "user-1");
  assert.ok(json.scopes.includes(SCOPES.connect));
});

await test("bearer: missing Authorization header -> 401 + WWW-Authenticate challenge", async () => {
  const { status, headers, json } = await request(resourcePort, "/mcp");
  assert.equal(status, 401);
  assert.ok(headers.get("www-authenticate").startsWith('Bearer error="invalid_token"'));
  assert.ok(headers.get("www-authenticate").includes('resource_metadata="'));
  assert.equal(json.error, "invalid_token");
});

await test("bearer: garbage/forged token -> 401", async () => {
  const { status } = await request(resourcePort, "/mcp", {
    headers: { Authorization: "Bearer not.a.jwt" },
  });
  assert.equal(status, 401);
});

await test("bearer: token signed by a different issuer -> 401", async () => {
  const token = await ctx.as.mintToken({
    sub: "user-1",
    scopes: Object.values(SCOPES),
    resource: RESOURCE,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iss: "https://evil.example",
  });
  const { status } = await request(resourcePort, "/mcp", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(status, 401);
});

await test("bearer: wrong audience (not the MCP resource) -> 401", async () => {
  const token = await ctx.as.mintToken({
    sub: "user-1",
    scopes: Object.values(SCOPES),
    resource: "https://other.example/api",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const { status } = await request(resourcePort, "/mcp", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(status, 401);
});

await test("bearer: expired token -> 401", async () => {
  const token = await ctx.as.mintToken({
    sub: "user-1",
    scopes: Object.values(SCOPES),
    resource: RESOURCE,
    exp: Math.floor(Date.now() / 1000) - 60,
  });
  const { status } = await request(resourcePort, "/mcp", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(status, 401);
});

await test("bearer: not-yet-valid token (future nbf) -> 401", async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await ctx.as.mintToken({
    sub: "user-1",
    scopes: Object.values(SCOPES),
    resource: RESOURCE,
    exp: now + 3600,
    nbf: now + 600,
  });
  // mintToken signs with iat=now; add nbf via a custom token
  const jwt = await new SignJWT({ scope: Object.values(SCOPES).join(" "), azp: CLIENT_ID })
    .setProtectedHeader({ alg: "RS256", kid: ctx.as.currentKid })
    .setSubject("user-1")
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setIssuedAt(now)
    .setNotBefore(now + 600)
    .setExpirationTime(now + 3600)
    .sign(ctx.as.signingKey);
  const { status } = await request(resourcePort, "/mcp", {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  assert.equal(status, 401);
});

await test("bearer: trailing-slash issuer (Auth0-style) accepted; exact issuer enforced", async () => {
  // Auth0's canonical issuer (and the `iss` claim on its tokens) carries a
  // trailing slash. Regression: the verifier used to strip the trailing slash
  // before jose's exact-string issuer check, which rejected valid Auth0 tokens.
  const resource = await buildResourceApp(asServer.address().port, ISSUER + "/");
  const resourceServer = await listen(resource.app);
  const port = resourceServer.address().port;
  try {
    const now = Math.floor(Date.now() / 1000);
    // Valid: token `iss` matches the configured trailing-slash issuer exactly.
    const ok = await ctx.as.mintToken({
      sub: "user-1",
      scopes: Object.values(SCOPES),
      resource: RESOURCE,
      exp: now + 3600,
      iss: ISSUER + "/",
    });
    assert.equal(
      (await request(port, "/mcp", { headers: { Authorization: `Bearer ${ok}` } })).status,
      200
    );
    // Invalid: token `iss` without the trailing slash must be rejected (exact match).
    const bad = await ctx.as.mintToken({
      sub: "user-1",
      scopes: Object.values(SCOPES),
      resource: RESOURCE,
      exp: now + 3600,
      iss: ISSUER, // no trailing slash
    });
    assert.equal(
      (await request(port, "/mcp", { headers: { Authorization: `Bearer ${bad}` } })).status,
      401
    );
  } finally {
    await closeServer(resourceServer);
  }
});

await test("bearer: token missing exp -> 401", async () => {
  // Regression: jose only validates `exp` when present; the resource server
  // must fail closed and require an expiration on access tokens.
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ scope: Object.values(SCOPES).join(" "), azp: CLIENT_ID })
    .setProtectedHeader({ alg: "RS256", kid: ctx.as.currentKid })
    .setSubject("user-1")
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setIssuedAt(now)
    .sign(ctx.as.signingKey);
  const { status } = await request(resourcePort, "/mcp", {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  assert.equal(status, 401);
});

await test("bearer: future iat -> 401", async () => {
  // Regression: jose does not validate `iat`; a token whose issued-at is in the
  // future must be rejected (beyond clock skew).
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ scope: Object.values(SCOPES).join(" "), azp: CLIENT_ID })
    .setProtectedHeader({ alg: "RS256", kid: ctx.as.currentKid })
    .setSubject("user-1")
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setIssuedAt(now + 3600) // iat in the future
    .setExpirationTime(now + 7200)
    .sign(ctx.as.signingKey);
  const { status } = await request(resourcePort, "/mcp", {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  assert.equal(status, 401);
});

await test("bearer: subject not in allowlist -> 401", async () => {
  const token = await ctx.as.mintToken({
    sub: "someone-else",
    scopes: Object.values(SCOPES),
    resource: RESOURCE,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const { status } = await request(resourcePort, "/mcp", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(status, 401);
});

await test("bearer: token missing base scope mcp:connect -> 403 insufficient_scope", async () => {
  const token = await ctx.as.mintToken({
    sub: "user-1",
    scopes: [SCOPES.filesRead],
    resource: RESOURCE,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const { status, headers } = await request(resourcePort, "/mcp", {
    headers: { Authorization: `Bearer ${token}` },
  });
  // RFC 6750: a valid token without the required scope is refused with 403.
  assert.equal(status, 403);
  assert.match(headers.get("www-authenticate") || "", /insufficient_scope/);
});

await test("per-tool scope: files:read token can call read tool, cannot call exec tool", async () => {
  const token = await ctx.as.mintToken({
    sub: "user-1",
    scopes: [SCOPES.connect, SCOPES.filesRead],
    resource: RESOURCE,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const call = (tool, kind) =>
    request(resourcePort, "/mcp/call", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tool, kind }),
    });
  assert.equal((await call("read_text_file", "READ")).status, 200);
  assert.equal((await call("run_command", "EXEC")).status, 403);
});

await test("per-tool scope: full token can call exec tool; computer:use override enforced", async () => {
  const token = await ctx.as.mintToken({
    sub: "user-1",
    scopes: Object.values(SCOPES),
    resource: RESOURCE,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const call = (tool, kind) =>
    request(resourcePort, "/mcp/call", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tool, kind }),
    });
  assert.equal((await call("run_command", "EXEC")).status, 200);
  assert.equal((await call("computer_act", "READ")).status, 200); // has computer:use
});

await test("per-tool scope: command-only token rejected for computer:use override", async () => {
  const token = await ctx.as.mintToken({
    sub: "user-1",
    scopes: [SCOPES.connect, SCOPES.commandsExecute],
    resource: RESOURCE,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const { status, json } = await request(resourcePort, "/mcp/call", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "computer_act", kind: "READ" }),
  });
  assert.equal(status, 403);
  assert.match(json.error, /computer:use/);
});

await test("pkce: full authorize -> code -> token (S256) flow accepted by resource server", async () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = sha256Base64url(verifier);
  const state = randomBytes(8).toString("hex");
  const scopes = Object.values(SCOPES).join(" ");

  // consent allow -> redirect with code
  const authRes = await request(asServer.address().port, `/authorize?redirect_uri=${encodeURIComponent(CALLBACK)}&code_challenge=${encodeURIComponent(challenge)}&state=${state}&scope=${encodeURIComponent(scopes)}&resource=${encodeURIComponent(RESOURCE)}`);
  assert.equal(authRes.status, 302);
  const loc = new URL(authRes.location);
  assert.equal(loc.searchParams.get("state"), state);
  const code = loc.searchParams.get("code");
  assert.ok(code);

  // token exchange with correct verifier
  const tokenRes = await request(asServer.address().port, "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: CALLBACK,
      client_id: CLIENT_ID,
    }).toString(),
  });
  assert.equal(tokenRes.status, 200, JSON.stringify(tokenRes.json));
  assert.ok(tokenRes.json.access_token);

  // use the token against the resource server
  const mcpRes = await request(resourcePort, "/mcp", {
    headers: { Authorization: `Bearer ${tokenRes.json.access_token}` },
  });
  assert.equal(mcpRes.status, 200);
  assert.equal(mcpRes.json.subject, "user-1");
});

await test("pkce: wrong code_verifier rejected with invalid_grant", async () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = sha256Base64url(verifier);
  const authRes = await request(asServer.address().port, `/authorize?redirect_uri=${encodeURIComponent(CALLBACK)}&code_challenge=${encodeURIComponent(challenge)}&scope=${encodeURIComponent(Object.values(SCOPES).join(" "))}`);
  assert.equal(authRes.status, 302);
  const code = new URL(authRes.location).searchParams.get("code");

  const tokenRes = await request(asServer.address().port, "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: "wrong-verifier",
      redirect_uri: CALLBACK,
      client_id: CLIENT_ID,
    }).toString(),
  });
  assert.equal(tokenRes.status, 400);
  assert.equal(tokenRes.json.error, "invalid_grant");
});

await test("pkce: consent denied -> authorize redirects access_denied (no code)", async () => {
  ctx.as.consent = "deny";
  try {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = sha256Base64url(verifier);
    const state = randomBytes(8).toString("hex");
    const authRes = await request(asServer.address().port, `/authorize?redirect_uri=${encodeURIComponent(CALLBACK)}&code_challenge=${encodeURIComponent(challenge)}&state=${state}`);
    assert.equal(authRes.status, 302);
    const loc = new URL(authRes.location);
    assert.equal(loc.searchParams.get("error"), "access_denied");
    assert.equal(loc.searchParams.get("state"), state);
    assert.equal(loc.searchParams.get("code"), null);
  } finally {
    ctx.as.consent = "allow";
  }
});

await test("refresh: refresh grant mints a token accepted by the resource server", async () => {
  const tokenRes = await request(asServer.address().port, "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: CLIENT_ID,
    }).toString(),
  });
  assert.equal(tokenRes.status, 200);
  const mcpRes = await request(resourcePort, "/mcp", {
    headers: { Authorization: `Bearer ${tokenRes.json.access_token}` },
  });
  assert.equal(mcpRes.status, 200);
});

await test("key rotation: old key removed from JWKS invalidates its tokens, new key works", async () => {
  // New signing key replaces the old one in the JWKS.
  const oldToken = await ctx.as.mintToken({
    sub: "user-1",
    scopes: Object.values(SCOPES),
    resource: RESOURCE,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  // valid before rotation
  assert.equal((await request(resourcePort, "/mcp", { headers: { Authorization: `Bearer ${oldToken}` } })).status, 200);

  await ctx.as.rotate(); // JWKS now only has the new key
  const newToken = await ctx.as.mintToken({
    sub: "user-1",
    scopes: Object.values(SCOPES),
    resource: RESOURCE,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  // wait past the JWKS cache + cooldown so the verifier re-fetches the rotated JWKS
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await request(resourcePort, "/mcp", { headers: { Authorization: `Bearer ${oldToken}` } })).status, 401);
  assert.equal((await request(resourcePort, "/mcp", { headers: { Authorization: `Bearer ${newToken}` } })).status, 200);
});

await test("fail-closed: oauth mode without issuer throws", async () => {
  await assert.rejects(
    createInboundAuth({ mode: "oauth", resourceUri: RESOURCE, allowedSubjects: ["user-1"] }),
    /INBOUND_OAUTH_ISSUER/
  );
});

await test("fail-closed: oauth mode without resource URI throws", async () => {
  await assert.rejects(
    createInboundAuth({ mode: "oauth", issuer: ISSUER, allowedSubjects: ["user-1"] }),
    /INBOUND_OAUTH_RESOURCE_URI/
  );
});

await test("fail-closed: oauth mode without allowed subjects throws", async () => {
  await assert.rejects(
    createInboundAuth({ mode: "oauth", issuer: ISSUER, resourceUri: RESOURCE }),
    /INBOUND_OAUTH_ALLOWED_SUBJECTS/
  );
});

await test("env: invalid INBOUND_AUTH_MODE throws; token mode parses", () => {
  process.env.INBOUND_AUTH_MODE = "bogus";
  assert.throws(() => inboundAuthOptionsFromEnv(), /Invalid INBOUND_AUTH_MODE/);
  process.env.INBOUND_AUTH_MODE = "token";
  const opts = inboundAuthOptionsFromEnv();
  assert.equal(opts.mode, "token");
  delete process.env.INBOUND_AUTH_MODE;
});

await test("end-to-end: real server in oauth mode guards /mcp and serves discovery", async () => {
  // Minimal localhost-issuer AS for the full server (dist/index.js).
  let asPort;
  const asApp = express();
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const pub = await exportJWK(publicKey);
  pub.kid = "smoke-k1";
  pub.alg = "RS256";
  asApp.use(express.json());
  asApp.use(express.urlencoded({ extended: true }));
  asApp.get("/.well-known/oauth-authorization-server", (_req, res) =>
    res.json({
      issuer: `http://127.0.0.1:${asPort}`,
      authorization_endpoint: `http://127.0.0.1:${asPort}/authorize`,
      token_endpoint: `http://127.0.0.1:${asPort}/token`,
      jwks_uri: `http://127.0.0.1:${asPort}/jwks`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    })
  );
  asApp.get("/jwks", (_req, res) => res.json({ keys: [pub] }));
  const asSrv = await listen(asApp);
  asPort = asSrv.address().port;

  const serverPort = 3321;
  const wsDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcp-oauth-e2e-"));
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(serverPort),
      HOST: "127.0.0.1",
      LOCAL_CODER_TUI: "off",
      LOCAL_CODER_ADMIN_ENABLED: "false",
      MCP_TOKEN: "",
      WORKSPACE_PATH: wsDir,
      INBOUND_AUTH_MODE: "oauth",
      INBOUND_OAUTH_ISSUER: `http://127.0.0.1:${asPort}`,
      INBOUND_OAUTH_RESOURCE_URI: "https://mcp.example/mcp",
      INBOUND_OAUTH_ALLOWED_SUBJECTS: "user-1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stdout += d));

  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try {
      const h = await request(serverPort, "/health");
      if (h.status === 200) {
        healthy = h.json?.authMode === "oauth";
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    assert.ok(healthy, `server did not reach oauth health: ${stdout.slice(-2000)}`);

    // Discovery is unauthenticated.
    const prm = await request(serverPort, "/.well-known/oauth-protected-resource/mcp");
    assert.equal(prm.status, 200);
    assert.equal(prm.json.resource, "https://mcp.example/mcp");

    // MCP route requires a valid Bearer token.
    const noAuth = await request(serverPort, "/mcp");
    assert.equal(noAuth.status, 401);
    assert.ok(noAuth.headers.get("www-authenticate").includes("resource_metadata="));

    // Wrong token still rejected; the tokenized /mcp/<token> path does not exist.
    const garbage = await request(serverPort, "/mcp", {
      headers: { Authorization: "Bearer not.a.jwt" },
    });
    assert.equal(garbage.status, 401);
    const tokenized = await request(serverPort, `/mcp/smoketok`);
    assert.equal(tokenized.status, 404);
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (!child.killed) child.kill("SIGKILL");
    await closeServer(asSrv);
  }
});

await test("cleanup: close servers", async () => {
  await closeServer(asServer);
  await closeServer(ctx.resourceServer);
});

console.log(`\nInbound OAuth: ${passed} tests passed.`);