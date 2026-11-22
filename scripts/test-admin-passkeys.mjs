#!/usr/bin/env node
/** Offline, synthetic authenticator end-to-end tests. No Apple Keychain or live service. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { encodeCBOR } from "@levischuck/tiny-cbor";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lcp-admin-passkeys-fixture-"));
const previous = {
  ADMIN_TOKEN: process.env.ADMIN_TOKEN,
  ADMIN_PASSKEY_FILE: process.env.ADMIN_PASSKEY_FILE,
};
const TOKEN = "TEST-ADMIN-TOKEN-NEVER-REAL-" + "x".repeat(45);
const storePath = path.join(tmp, "test-passkeys.json");
process.env.ADMIN_TOKEN = TOKEN;
process.env.ADMIN_PASSKEY_FILE = storePath;
const { startAdminServer } = await import("../dist/admin/server.js");
const manager = {
  listStatuses: async () => [],
  getConfig: () => ({ version: 1, servers: [] }),
  getConfigPath: () => path.join(tmp, "upstream.json"),
};
let server;

function base64(value) { return Buffer.from(value).toString("base64url"); }
function digest(value) { return createHash("sha256").update(value).digest(); }
function cborMap(entries) { return Buffer.from(encodeCBOR(new Map(entries))); }

try {
  server = startAdminServer({
    host: "127.0.0.1", port: 0, mcpPort: 0, pid: process.pid,
    transportMode: "json", keepAliveMs: 0, manager, sessionCount: () => 0,
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const origin = `http://localhost:${port}`;
  const base = `http://127.0.0.1:${port}`;

  async function request(endpoint, { method = "GET", cookie = "", csrf = "", body, host = "localhost" } = {}) {
    const headers = { Host: `${host}:${port}` };
    if (method !== "GET") headers.Origin = host === "localhost" ? origin : `http://${host}:${port}`;
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers["X-LCP-Admin-CSRF"] = csrf;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return await new Promise((resolve, reject) => {
      // Node's fetch ignores Host overrides. A raw local HTTP request allows
      // a deterministic localhost-origin test against an IPv4-only listener.
      const call = httpRequest({ hostname: "127.0.0.1", port, path: endpoint, method, headers }, (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => {
          let data = {};
          try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
          const cookies = incoming.headers["set-cookie"] ?? [];
          const text = Buffer.concat(chunks).toString();
          resolve({
            text,
            response: {
              status: incoming.statusCode,
              headers: { getSetCookie: () => cookies },
            },
            data, cookie: cookies.join(","),
          });
        });
      });
      call.once("error", reject);
      call.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  const prefix = "/api/auth/passkeys";
  const vendor = await request("/ui/passkeys-vendor.js");
  assert.equal(vendor.response.status, 200, "pinned WebAuthn bundle must be served from loopback");
  assert.ok(vendor.text.includes("SimpleWebAuthnBrowser"), "vendor bundle must expose WebAuthn helper");
  const status = await request(prefix + "/status");
  assert.equal(status.response.status, 200);
  assert.equal(status.data.registered, false);

  const initialAttempt = await request(prefix + "/authentication/options", { method: "POST" });
  assert.equal(initialAttempt.response.status, 404, JSON.stringify(initialAttempt.data));
  const blockedEnroll = await request(prefix + "/registration/options", { method: "POST" });
  assert.equal(blockedEnroll.response.status, 401);
  const legacyHost = await request(prefix + "/authentication/options", { method: "POST", host: "127.0.0.1" });
  assert.equal(legacyHost.response.status, 400);

  const login = await request("/api/auth/login", { method: "POST", body: { token: TOKEN } });
  assert.equal(login.response.status, 200);
  const tokenCookie = login.cookie.split(";")[0];
  assert.match(tokenCookie, /lcp_admin_session=/);
  const csrf = login.data.csrf;
  const blockedCsrf = await request(prefix + "/registration/options", {
    method: "POST", cookie: tokenCookie,
  });
  assert.equal(blockedCsrf.response.status, 403);

  const registration = await request(prefix + "/registration/options", {
    method: "POST", cookie: tokenCookie, csrf,
  });
  assert.equal(registration.response.status, 200);
  assert.equal(registration.data.options.rp.id, "localhost");
  assert.equal(registration.data.options.authenticatorSelection.userVerification, "required");
  assert.equal(registration.data.options.authenticatorSelection.residentKey, "required");

  // Create a FIDO2 P-256 authenticator in memory and build a real signature
  // over the WebAuthn assertion. This proves RP ID/origin/challenge/UV checks
  // using the actual SimpleWebAuthn library instead of mocked success values.
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keys.publicKey.export({ format: "jwk" });
  const credentialID = Buffer.from("synthetic-passkey-credential-id");
  const credentialID64 = base64(credentialID);
  const coseKey = cborMap([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, "base64url")],
    [-3, Buffer.from(jwk.y, "base64url")],
  ]);
  const makeAuthData = (counter, withCredential = false) => {
    const data = Buffer.alloc(37);
    digest("localhost").copy(data, 0);
    data[32] = withCredential ? 0x45 : 0x05; // UP+UV+(AT for registration)
    data.writeUInt32BE(counter, 33);
    if (!withCredential) return data;
    const header = Buffer.alloc(18);
    header.writeUInt16BE(credentialID.length, 16);
    return Buffer.concat([data, header, credentialID, coseKey]);
  };
  const creationClient = Buffer.from(JSON.stringify({
    type: "webauthn.create", challenge: registration.data.options.challenge,
    origin, crossOrigin: false,
  }));
  const attestation = cborMap([
    ["fmt", "none"], ["attStmt", new Map()],
    ["authData", makeAuthData(0, true)],
  ]);
  const assertion = {
    id: credentialID64,
    rawId: credentialID64,
    type: "public-key",
    response: {
      clientDataJSON: base64(creationClient),
      attestationObject: base64(attestation),
      transports: ["internal"],
    },
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };

  // Wrong challenge is rejected and consumes the original challenge.
  const wrongChallenge = structuredClone(assertion);
  const wrongData = JSON.parse(creationClient.toString());
  wrongData.challenge = base64(Buffer.from("another-challenge"));
  wrongChallenge.response.clientDataJSON = base64(Buffer.from(JSON.stringify(wrongData)));
  const invalidRegistration = await request(prefix + "/registration/verify", {
    method: "POST", cookie: tokenCookie, csrf, body: wrongChallenge,
  });
  assert.equal(invalidRegistration.response.status, 400);
  const consumedRegistration = await request(prefix + "/registration/verify", {
    method: "POST", cookie: tokenCookie, csrf, body: assertion,
  });
  assert.equal(consumedRegistration.response.status, 400);
  assert.equal((await request(prefix + "/status")).data.registered, false);

  const renewedRegistration = await request(prefix + "/registration/options", {
    method: "POST", cookie: tokenCookie, csrf,
  });
  assert.equal(renewedRegistration.response.status, 200);
  const newClient = Buffer.from(JSON.stringify({
    type: "webauthn.create", challenge: renewedRegistration.data.options.challenge, origin,
  }));
  assertion.response.clientDataJSON = base64(newClient);
  const approvedRegistration = await request(prefix + "/registration/verify", {
    method: "POST", cookie: tokenCookie, csrf, body: assertion,
  });
  assert.equal(approvedRegistration.response.status, 200);
  assert.equal((await request(prefix + "/status")).data.registered, true);
  const permissions = (await fs.stat(storePath)).mode & 0o777;
  assert.equal(permissions, 0o600, "credential metadata store must be private");

  const authOptions = await request(prefix + "/authentication/options", { method: "POST" });
  assert.equal(authOptions.response.status, 200);
  assert.match(authOptions.cookie, /HttpOnly/);
  const challengeCookie = authOptions.cookie.split(";")[0];
  const opts = authOptions.data.options;
  assert.equal(opts.rpId, "localhost");
  assert.equal(opts.userVerification, "required");

  const authData = makeAuthData(1);
  const clientData = Buffer.from(JSON.stringify({
    type: "webauthn.get", challenge: opts.challenge, origin,
  }));
  const signed = sign("sha256", Buffer.concat([authData, digest(clientData)]), keys.privateKey);
  const authentication = {
    id: credentialID64, rawId: credentialID64, type: "public-key",
    response: {
      authenticatorData: base64(authData),
      clientDataJSON: base64(clientData),
      signature: base64(signed),
      userHandle: null,
    },
    clientExtensionResults: {},
  };

  const valid = await request(prefix + "/authentication/verify", {
    method: "POST", cookie: challengeCookie, body: authentication,
  });
  assert.equal(valid.response.status, 200);
  assert.equal(valid.data.authenticated, true);
  const passkeyCookie = valid.cookie.split(",").find((item) => item.includes("lcp_admin_session="))?.split(";")[0]?.trim() ||
    valid.response.headers.getSetCookie().find((s) => s.includes("lcp_admin_session=")).split(";")[0];
  assert.ok(passkeyCookie);
  assert.equal((await request("/api/upstream", { cookie: passkeyCookie })).response.status, 200);
  const session = await request("/api/auth/session", { cookie: passkeyCookie });
  assert.equal(session.data.viaToken, false);

  const replay = await request(prefix + "/authentication/verify", {
    method: "POST", cookie: challengeCookie, body: authentication,
  });
  assert.equal(replay.response.status, 400, "a passkey signature must be bound to a single-use challenge");

  async function attackAttempt({ signedOrigin = origin, userVerified = true, rpName = "localhost" }) {
    const optionsResponse = await request(prefix + "/authentication/options", { method: "POST" });
    assert.equal(optionsResponse.response.status, 200);
    const candidateAuthData = Buffer.from(makeAuthData(2));
    if (!userVerified) candidateAuthData[32] = 0x01; // UP only, no biometric/PIN verification
    if (rpName !== "localhost") digest(rpName).copy(candidateAuthData, 0);
    const candidateClient = Buffer.from(JSON.stringify({
      type: "webauthn.get", challenge: optionsResponse.data.options.challenge,
      origin: signedOrigin,
    }));
    const candidateSignature = sign("sha256",
      Buffer.concat([candidateAuthData, digest(candidateClient)]), keys.privateKey);
    return request(prefix + "/authentication/verify", {
      method: "POST",
      cookie: optionsResponse.cookie.split(";")[0],
      body: {
        ...authentication,
        response: {
          ...authentication.response,
          authenticatorData: base64(candidateAuthData),
          clientDataJSON: base64(candidateClient),
          signature: base64(candidateSignature),
        },
      },
    });
  }
  assert.equal((await attackAttempt({ signedOrigin: "http://localhost:4444" })).response.status, 401,
    "authentication must reject a passkey signed for another origin/port");
  assert.equal((await attackAttempt({ userVerified: false })).response.status, 401,
    "authentication must require actual user verification");
  assert.equal((await attackAttempt({ rpName: "untrusted.example" })).response.status, 401,
    "authentication must check the localhost RP hash");

  const untrustedManage = await request(prefix + "/registration/options", {
    method: "POST", cookie: passkeyCookie, csrf: session.data.csrf,
  });
  assert.equal(untrustedManage.response.status, 403, "passkey-only sessions cannot add new passkeys");

  // Revoke with a token-authenticated session; credential stays in Apple
  // Passwords until the user also deletes it there.
  const revoked = await request(prefix + "/revoke", {
    method: "POST", cookie: tokenCookie, csrf, body: { id: credentialID64 },
  });
  assert.equal(revoked.response.status, 200);
  assert.equal((await request(prefix + "/status")).data.registered, false);
  assert.equal((await request("/api/upstream", { cookie: passkeyCookie })).response.status, 401,
    "revoking a passkey must immediately invalidate sessions created with that passkey");
  assert.equal((await request("/api/upstream", { cookie: tokenCookie })).response.status, 200,
    "recovery token sessions must survive passkey revocation");

  await new Promise((resolve) => server.close(resolve));
  server = undefined;
  await fs.writeFile(storePath, "{invalid JSON", { mode: 0o600 });
  assert.throws(() => startAdminServer({
    host: "127.0.0.1", port: 0, mcpPort: 0, pid: process.pid,
    transportMode: "json", keepAliveMs: 0, manager, sessionCount: () => 0,
  }), /Unexpected token|JSON|Invalid/, "corrupt passkey registry must fail closed");

  console.log("OK Admin WebAuthn: token-gated enrollment, real P-256 registration/login, UV and exact RP origin, challenge replay rejection, signed persistence, token-only revocation");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true });
}
