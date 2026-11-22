/** P0.5: isolated Admin environment-secret exposure and safe round-trip. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lcp-admin-env-test-"));
const originalCwd = process.cwd();
const oldToken = process.env.ADMIN_TOKEN;
try {
  process.chdir(dir);
  delete process.env.ADMIN_TOKEN;
  const envPath = path.join(dir, ".env");
  const secret = "synthetic-secret-fixture-never-a-live-token";
  await fs.writeFile(envPath, [
    "MCP_TOKEN=" + secret, "AUTH0_CLIENT_SECRET=" + secret,
    "DEEPINFRA_API_KEY=" + secret, "WORKSPACE_PATH=/tmp/disposable", "",
  ].join("\n"));
  const { createAdminRouter } = await import("../dist/admin/routes.js");
  const app = express();
  app.use(express.json());
  app.use(createAdminRouter({}, {
    mcpPort: 0, pid: process.pid, transportMode: "json",
    keepAliveMs: 1000, sessionCount: () => 0,
  }));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const base = "http://127.0.0.1:" + server.address().port;
    const get = async () => fetch(base + "/api/config/env").then((r) => r.json());
    const first = await get();
    assert.equal(first.values.WORKSPACE_PATH, "/tmp/disposable");
    assert.deepEqual(first.redacted_keys.sort(),
      ["AUTH0_CLIENT_SECRET", "DEEPINFRA_API_KEY", "MCP_TOKEN"].sort());
    assert.ok(!JSON.stringify(first).includes(secret), "GET leaked synthetic secrets");
    const save = async (values) => {
      const response = await fetch(base + "/api/config/env", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ values }),
      });
      return { status: response.status, body: await response.json() };
    };
    const saved = await save({ WORKSPACE_PATH: "/tmp/updated", MCP_TOKEN: "" });
    assert.equal(saved.status, 200);
    assert.match(await fs.readFile(envPath, "utf8"), /WORKSPACE_PATH=\/tmp\/updated/);
    assert.match(await fs.readFile(envPath, "utf8"), new RegExp(secret));
    const denied = await save({ MCP_TOKEN: "unsafe-write" });
    assert.equal(denied.status, 403);
    assert.ok(!(await fs.readFile(envPath, "utf8")).includes("unsafe-write"));
    const second = await get();
    assert.ok(!JSON.stringify(second).includes(secret), "GET leaked a synthetic secret after PUT");
    console.log("OK Admin GET redacts secrets and PUT preserves hidden values; unauthenticated secret rotation denied");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
} finally {
  if (oldToken === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = oldToken;
  process.chdir(originalCwd);
  await fs.rm(dir, { recursive: true, force: true });
}
