/**
 * Local ChatGPT Plus — read-only/isolated pre-flight security smoke check.
 *
 * Runs quickly without a live tunnel, Auth0, real .env, real .mcp-state, or a
 * production port. It asserts the fail-closed invariants at the module layer and
 * then reports OK / SKIP / FAIL per surface. It is NOT the full regression suite
 * (see `npm test` / `npm run test:all`) and never validates the live deployment.
 *
 * Surfaces:
 *   1. Auth0 token-vs-token-mode config validation (parameterized token mode,
 *      invalid mode rejection, oauth fail-closed on missing issuer / resource / subjects)
 *   2. Admin loopback isolation + admin token (localhost-only, token gate)
 *   3. Permission profile fail-closed (missing config, invalid profile, read_only gates)
 *   4. Path / symlink escape rejection
 *   5. Upstream MCP allowlist enforcement (unlisted tool never reaches upstream)
 *   6. Headless computer-approval fail-closed (denial short-circuits, never cached)
 *   7. Native PTY / LSP smoke (only when the underlying dependency is installed)
 *
 * Usage: node scripts/smoke-security-check.mjs   (after `npm run build`)
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn as spawnProcess, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { inboundAuthOptionsFromEnv, createInboundAuth } from "../dist/lib/inbound-oauth/index.js";
import { getPermissionConfig, savePermissionConfig, canWriteFiles, canRunCommands, canUseUnsafeRuntimes } from "../dist/lib/permissions.js";
import { validatePath, setDefaultCwd } from "../dist/lib/path-security.js";
import { approvalMode, needsComputerApproval, requireComputerApproval } from "../dist/lib/computer-approval.js";
import { localhostOnly, adminAuth } from "../dist/admin/localhost-guard.js";
import { registerMcpBridgeTools } from "../dist/tools/mcp-bridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "lcp-smoke-security-"));
let failures = 0;
let skips = 0;

function record(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`OK     ${label}`))
    .catch((error) => {
      if (error && error.code === "SMOKE_SKIP") {
        skips += 1;
        console.log(`SKIP   ${label}: ${error.message}`);
        return;
      }
      failures += 1;
      console.error(`FAIL   ${label}: ${error instanceof Error ? error.message : error}`);
    });
}

// Escape hatch for surfaces that can only be checked when optional tooling is
// installed (language servers). Callers are responsible for cleaning scratch.
function skip(message) { const e = new Error(message); e.code = "SMOKE_SKIP"; throw e; }

// --- Environment snapshot/restore (mutates only process.env for this process) ---
const envKeys = [
  "INBOUND_AUTH_MODE", "INBOUND_OAUTH_ISSUER", "INBOUND_OAUTH_RESOURCE_URI",
  "INBOUND_OAUTH_ALLOWED_SUBJECTS", "PERMISSIONS_CONFIG", "MCP_COMPUTER_APPROVAL_MODE", "ADMIN_TOKEN",
];
const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
const restore = () => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
};

try {
  // ---------------------------------------------------------------- 1. Auth mode
  await record("token mode is the default (no OAuth requirements, no network)", async () => {
    delete process.env.INBOUND_AUTH_MODE;
    const opts = inboundAuthOptionsFromEnv();
    assert.equal(opts.mode, "token");
    const auth = await createInboundAuth({ mode: "token" });
    assert.equal(auth.isOauthMode, false);
    assert.equal(auth.metadataRouter, undefined);
  });

  await record("invalid INBOUND_AUTH_MODE is rejected", async () => {
    process.env.INBOUND_AUTH_MODE = "bogus";
    assert.throws(() => inboundAuthOptionsFromEnv(), /Invalid INBOUND_AUTH_MODE/);
  });

  await record("oauth mode fails closed without issuer / resource / allowed subjects", async () => {
    process.env.INBOUND_AUTH_MODE = "oauth";
    // Each of these must throw before any network discovery, so they are safe here.
    await assert.rejects(
      createInboundAuth({ mode: "oauth", resourceUri: "https://rs.local", allowedSubjects: ["u-1"] }),
      /requires INBOUND_OAUTH_ISSUER/i
    );
    await assert.rejects(
      createInboundAuth({ mode: "oauth", issuer: "https://issuer.local", allowedSubjects: ["u-1"] }),
      /requires INBOUND_OAUTH_RESOURCE_URI/i
    );
    await assert.rejects(
      createInboundAuth({ mode: "oauth", issuer: "https://issuer.local", resourceUri: "https://rs.local" }),
      /INBOUND_OAUTH_ALLOWED_SUBJECTS/i
    );
  });

  // ---------------------------------------------------------------- 2. Admin loopback
  await record("Admin localhost-only guard rejects non-loopback and allows loopback", async () => {
    const makeRes = () => {
      const res = { statusCode: 0, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      return res;
    };
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    const remote = makeRes();
    localhostOnly({ socket: { remoteAddress: "203.0.113.5" } }, remote, next);
    assert.equal(remote.statusCode, 403);
    assert.match(JSON.stringify(remote.body), /localhost-only/i);
    assert.equal(nextCalled, false);
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      nextCalled = false;
      localhostOnly({ socket: { remoteAddress: ip, localPort: 3001 }, headers: { host: "127.0.0.1:3001" } }, makeRes(), next);
      assert.equal(nextCalled, true, `loopback ${ip} must pass`);
    }
  });

  await record("Admin token gate: wrong token 401, valid token passes, absent token fails closed", async () => {
    process.env.ADMIN_TOKEN = "smoke-secret";
    const next = () => {};
    const res401 = { statusCode: 0, json() { return this; } };
    res401.status = (c) => { res401.statusCode = c; return res401; };
    let passed = false;
    adminAuth({ headers: { authorization: "Bearer wrong" } }, res401, () => { passed = true; });
    assert.equal(res401.statusCode, 401);
    assert.equal(passed, false);
    adminAuth({ headers: { authorization: "Bearer smoke-secret" } }, res401, () => { passed = true; });
    assert.equal(passed, true);
    delete process.env.ADMIN_TOKEN;
    passed = false;
    adminAuth({ headers: {} }, res401, () => { passed = true; });
    assert.equal(passed, false, "missing ADMIN_TOKEN must never allow Admin requests");
    assert.equal(res401.statusCode, 503);
  });

  // ---------------------------------------------------------------- 3. Permission profile
  await record("permission profile fails closed on missing explicit config", async () => {
    const missing = path.join(scratch, "does-not-exist", "permissions.json");
    process.env.PERMISSIONS_CONFIG = missing;
    assert.throws(() => getPermissionConfig(), /not found at explicitly configured PERMISSIONS_CONFIG/i);
  });

  await record("invalid permission profile / version rejected", async () => {
    const cfg = path.join(scratch, "perm-invalid.json");
    await fs.writeFile(cfg, JSON.stringify({ version: 1, profile: "yolo" }), "utf-8");
    process.env.PERMISSIONS_CONFIG = cfg;
    assert.throws(() => getPermissionConfig(), /Invalid permission profile/i);
    await fs.writeFile(cfg, JSON.stringify({ version: 99, profile: "open" }), "utf-8");
    assert.throws(() => getPermissionConfig(), /Unsupported permission config version/i);
  });

  await record("read_only profile denies write / commands / unsafe runtimes", async () => {
    const cfg = path.join(scratch, "perm-ro.json");
    await fs.writeFile(cfg, JSON.stringify({ version: 1, profile: "read_only" }), "utf-8");
    process.env.PERMISSIONS_CONFIG = cfg;
    assert.equal(getPermissionConfig().profile, "read_only");
    assert.equal(canWriteFiles(), false);
    assert.equal(canRunCommands(), false);
    assert.equal(canUseUnsafeRuntimes(), false);
  });

  // ---------------------------------------------------------------- 4. Path / symlink escape
  await record("validatePath rejects a symlink from inside roots to outside roots", async () => {
    const permRoot = path.join(scratch, "ws");
    const outside = path.join(scratch, "outside");
    const link = path.join(permRoot, "escape-link");
    await fs.mkdir(permRoot, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    const cfg = path.join(scratch, "perm-ws.json");
    await fs.writeFile(cfg, JSON.stringify({ version: 1, profile: "workspace", path_roots: [permRoot] }), "utf-8");
    process.env.PERMISSIONS_CONFIG = cfg;
    setDefaultCwd(permRoot);
    try {
      await fs.symlink(outside, link, "dir");
    } catch {
      skip("symlink creation not permitted on this host");
    }
    await assert.rejects(validatePath(path.join(link, "secret.txt")), /symlink|junction|escapes configured roots/i);
    // A plain in-root path still validates.
    assert.equal(await validatePath(path.join(permRoot, "ok.txt")), path.join(permRoot, "ok.txt"));
  });

  // ---------------------------------------------------------------- 5. Upstream allowlist
  await record("upstream allowlist denies unlisted/excluded tools before upstream call", async () => {
    const permRoot = path.join(scratch, "ws");
    await fs.mkdir(permRoot, { recursive: true });
    const cfg = path.join(scratch, "perm-allowlist.json");
    await fs.writeFile(cfg, JSON.stringify({ version: 1, profile: "open" }), "utf-8");
    process.env.PERMISSIONS_CONFIG = cfg;
    savePermissionConfig({ profile: "open" });

    let config = { id: "up", enabled: true, expose: "allowlist", tools: ["allowed"], tool_prefix: "up" };
    const available = ["allowed", "unlisted"].map((name) => ({ name, description: name, annotations: { readOnlyHint: true } }));
    const calls = [];
    const manager = {
      getServerConfig: (id) => (id === "up" ? config : undefined),
      listServerConfigs: () => [config],
      async listTools() { return available; },
      getProxiedToolNames(c, tools) {
        if (!c.enabled || c.expose === "none" || c.expose === "meta_only") return [];
        return tools
          .filter((item) => (c.expose === "all" || c.tools.includes(item.name)) && !(c.disabled_tools ?? []).includes(item.name))
          .map((item) => (c.tool_prefix ?? c.id) + "__" + item.name);
      },
      async callTool(id, tool) { calls.push(tool); return { structuredContent: { ok: true } }; },
      async listStatuses() { return []; },
      async reloadConfig() {},
    };
    const server = new McpServer({ name: "smoke", version: "1.0.0" });
    registerMcpBridgeTools(server, manager);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "smoke-client", version: "1.0.0" }, { capabilities: {} });
    try {
      await server.connect(st);
      await client.connect(ct);
      const inv = (name, args) => client.callTool({ name, arguments: args }).catch((e) => e);
      await inv("up__unlisted", {});
      assert.equal(calls.length, 0, "unlisted upstream tool must never reach the provider");
      await inv("mcp_call", { server_id: "up", tool: "unlisted" }).then((r) => {
        assert.match(JSON.stringify(r), /not exposed|not allowed|disabled/i);
      });
      assert.equal(calls.length, 0);
      const list = await inv("mcp_tools", { server_id: "up" });
      assert.equal(list.structuredContent?.data?.tools.some((t) => t.name === "unlisted"), false);
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  // ---------------------------------------------------------------- 6. Headless approval
  await record("computer approval denies (headless-safe, never cached, bounded scope)", async () => {
    process.env.MCP_COMPUTER_APPROVAL_MODE = "sensitive";
    assert.equal(approvalMode(), "sensitive");
    process.env.MCP_COMPUTER_APPROVAL_MODE = "bogus";
    assert.throws(() => approvalMode(), /off, sensitive, or all/);
    process.env.MCP_COMPUTER_APPROVAL_MODE = "sensitive";
    assert.equal(needsComputerApproval("desktop_type"), true);
    assert.equal(needsComputerApproval("desktop_click"), false);
    let denied = 0;
    await assert.rejects(
      requireComputerApproval("desktop", "desktop_type", "smoke-scope", async () => { denied += 1; return false; }),
      /denied by the local operator/
    );
    await assert.rejects(
      requireComputerApproval("desktop", "desktop_type", "smoke-scope", async () => { denied += 1; return false; }),
      /denied by the local operator/
    );
    assert.equal(denied, 2, "a denied grant must not be cached");
    await assert.rejects(
      requireComputerApproval("desktop", "desktop_type", "x".repeat(401), async () => true),
      /bounded scope/
    );
  });

  // ---------------------------------------------------------------- 7. PTY / LSP smoke
  await record("node-pty spawn/signal smoke (dependency installed)", async () => {
    const pty = createRequire(import.meta.url)("node-pty").spawn("/bin/sh", ["-l"], {
      name: "xterm-256color", cols: 80, rows: 24, cwd: root, env: process.env,
    });
    let output = "";
    const done = new Promise((resolve) => { pty.onData((d) => { output += d; if (output.includes("SMOKE_OK")) resolve(); }); });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("pty smoke timed out")), 8000));
    pty.write("printf 'SMOKE_OK\\n'\n");
    await Promise.race([done, timeout]);
    assert.match(output, /SMOKE_OK/);
    pty.kill();
  });

  await record("language-server binary presence (skipped when not installed)", async () => {
    const servers = ["typescript-language-server", "pyright", "basedpyright", "pylsp", "clangd", "gopls"];
    const found = servers.find((s) => { try { execFileSync("which", [s], { stdio: "ignore" }); return true; } catch { return false; } });
    if (!found) skip("no language server in PATH (install typescript-language-server/pyright to enable the full handshake)");
    // Present: bounded stdio liveness probe. A full handshake still needs the project + client.
    const child = spawnProcess(found, ["--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(child.exitCode, null, `${found} exited immediately on --stdio`);
    child.kill();
  });
} finally {
  restore();
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
}

console.log(`\nSmoke summary: ${failures === 0 ? "PASS" : "FAIL"} (${failures} failed, ${skips} skipped)`);
process.exit(failures === 0 ? 0 : 1);