/** Production Admin auth, CSRF, loopback and upstream secret-boundary regression. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cwd = process.cwd();
const oldAdmin = process.env.ADMIN_TOKEN;
const oldPasskeyFile = process.env.ADMIN_PASSKEY_FILE;
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "lcp-admin-harden-"));
const canary = "SYNTHETIC-CREDENTIAL-NOT-REAL-abc0123456789";
const realToken = "SYNTHETIC-ADMIN-TEST-TOKEN-" + "a".repeat(48);

try {
  process.env.ADMIN_PASSKEY_FILE = path.join(scratch, "admin-passkeys.json");
  process.chdir(scratch);
  const { startAdminServer } = await import("../dist/admin/server.js");
  delete process.env.ADMIN_TOKEN;
  const dummy = { listStatuses: async () => [], getConfig: () => ({ version: 1, servers: [] }) };
  assert.throws(() => startAdminServer({
    port: 0, mcpPort: 0, pid: process.pid, transportMode: "json",
    keepAliveMs: 0, manager: dummy, sessionCount: () => 0,
  }), /ADMIN_TOKEN is empty/);

  process.env.ADMIN_TOKEN = realToken;
  await fs.writeFile(path.join(scratch, ".env"), "MCP_TOKEN=" + canary + "\nWORKSPACE_PATH=/tmp/fixture\n", { mode: 0o600 });

  let config = { version: 1, servers: [{
    id: "mock", name: "Mock upstream", enabled: false, transport: "http",
    url: "https://example.invalid/mcp?key=" + canary,
    command: "secret-cmd-" + canary,
    args: ["--credential", canary],
    env: { TEST_PRIVATE: canary }, headers: { "X-Synthetic-Key": canary },
    expose: "none",
  }] };
  let mutations = 0;
  const manager = {
    listStatuses: async () => [],
    getConfig: () => config,
    getConfigPath: () => path.join(scratch, "upstream.json"),
    getServerConfig: (id) => config.servers.find((server) => server.id === id),
    upsertServer: async (server) => {
      config.servers = config.servers.map((existing) => existing.id === server.id ? server : existing);
      mutations++;
    },
    updateConfig: async (next) => { config = next; mutations++; return config; },
  };

  const server = startAdminServer({
    port: 0, mcpPort: 0, pid: process.pid, transportMode: "json",
    keepAliveMs: 0, manager, sessionCount: () => 0,
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;

  const req = async (pathValue, method = "GET", headers = {}, body) =>
    fetch(base + pathValue, {
      method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  try {
    const staticUi = await req("/ui/");
    assert.equal(staticUi.status, 200);
    assert.equal(staticUi.headers.get("x-frame-options"), "DENY");
    assert.ok(!(await staticUi.text()).includes(canary));

    assert.equal((await req("/health")).status, 401, "no anonymous health metadata");
    assert.equal((await req("/api/upstream")).status, 401);
    assert.equal((await req("/api/upstream", "POST", {}, { server: config.servers[0] })).status, 401);
    assert.equal(mutations, 0);

    const invalid = await req("/api/auth/login", "POST", {}, { token: "wrong" });
    assert.equal(invalid.status, 401);
    const login = await req("/api/auth/login", "POST", {}, { token: realToken });
    assert.equal(login.status, 200);
    const cookieLine = login.headers.get("set-cookie");
    assert.ok(cookieLine.includes("HttpOnly") && cookieLine.includes("SameSite=Strict"));
    const cookie = cookieLine.split(";")[0];
    const loginBody = await login.json();
    const csrf = loginBody.csrf;
    const proof = loginBody.proof;
    assert.ok(csrf && csrf !== realToken);
    assert.ok(proof && proof !== csrf && proof !== realToken, "session origin proof is independent");
    assert.ok(!JSON.stringify(loginBody).includes(realToken), "login response must not echo Admin token");

    assert.equal((await req("/api/auth/session", "GET", { Cookie: cookie })).status, 401,
      "a localhost session cookie stolen by another local port must be useless");
    assert.equal((await req("/api/upstream", "GET", { Cookie: cookie, "x-lcp-admin-csrf": csrf })).status, 401,
      "CSRF token cannot replace origin-scoped session proof");
    const withCookie = { Cookie: cookie, "x-lcp-admin-proof": proof };
    const session = await req("/api/auth/session", "GET", withCookie);
    assert.equal(session.status, 200);
    assert.equal((await session.json()).csrf, csrf);
    assert.equal((await req("/api/upstream", "POST", withCookie, { server: config.servers[0] })).status, 403);

    const maliciousOrigin = await req("/api/upstream", "POST",
      { ...withCookie, Origin: "https://untrusted.example", "x-lcp-admin-csrf": csrf },
      { server: config.servers[0] });
    assert.equal(maliciousOrigin.status, 403);

    const sensitivePaths = ["/api/upstream", "/api/config/env", "/health"];
    for (const endpoint of sensitivePaths) {
      const response = await req(endpoint, "GET", withCookie);
      assert.equal(response.status, 200, endpoint);
      const text = await response.text();
      assert.ok(!text.includes(canary), endpoint + " leaked the synthetic credential");
    }

    const publicCfg = (await (await req("/api/upstream", "GET", withCookie)).json()).config.servers[0];
    assert.equal(publicCfg.headers["X-Synthetic-Key"], "");
    assert.equal(publicCfg.env.TEST_PRIVATE, "");
    assert.equal(publicCfg.args.length, 2);
    assert.ok(!JSON.stringify(publicCfg).includes(canary));

    const updated = await req("/api/upstream", "POST",
      { ...withCookie, "x-lcp-admin-csrf": csrf }, { server: publicCfg });
    assert.equal(updated.status, 200);
    assert.equal(mutations, 1);
    assert.equal(config.servers[0].headers["X-Synthetic-Key"], canary);
    assert.equal(config.servers[0].env.TEST_PRIVATE, canary);
    assert.equal(config.servers[0].args[1], canary);
    assert.ok(!(await updated.text()).includes(canary), "POST response leaked credential");

    const replaced = await req("/api/upstream", "PUT",
      { ...withCookie, "x-lcp-admin-csrf": csrf }, { config: { version: 1, servers: [publicCfg] } });
    assert.equal(replaced.status, 200);
    assert.equal(config.servers[0].url.includes(canary), true);
    assert.ok(!(await replaced.text()).includes(canary), "PUT response leaked credential");

    assert.equal((await req("/api/upstream", "GET", { Authorization: "Bearer " + realToken })).status, 200);

    process.env.ADMIN_TOKEN = "ROTATED-TEST-" + "b".repeat(48);
    assert.equal((await req("/api/upstream", "GET", withCookie)).status, 401,
      "rotating Admin token must invalidate old sessions");
    console.log("OK Admin auth+CSRF+redaction: anonymous blocked, browser session guarded, all config secrets masked, token rotation invalidates cookies");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
} finally {
  if (oldAdmin === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = oldAdmin;
  if (oldPasskeyFile === undefined) delete process.env.ADMIN_PASSKEY_FILE;
  else process.env.ADMIN_PASSKEY_FILE = oldPasskeyFile;
  process.chdir(cwd);
  await fs.rm(scratch, { recursive: true, force: true });
}
