/** Hermetic launchd observer tests; no live service/config is modified. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createDashboardTunnelResolver } from "../dist/lib/dashboard-tunnel-status.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = "/Users/test-operator";
const jobFile = home + "/.local/lcp/launchd/com.localchatgpt.plus.tunnel.plist";
const profileFile = home + "/lcp-tunnel.yaml";
const token = "synthetic-no-real-secrets";
const profile = [
  "health:", "  listen_addr: 127.0.0.1:8090", "mcp:",
  "  server_urls:", "    - channel: main",
  "      url: http://127.0.0.1:3000/mcp/" + token,
].join("\n");
function job(state = "running", pid = 1234, runs = 1, location = jobFile) {
  return [
    "gui/501/com.localchatgpt.plus.tunnel = {",
    "  path = " + location, "  type = LaunchAgent",
    "  state = " + state, "  program = /opt/homebrew/bin/tunnel-client",
    "  arguments = {", "    /opt/homebrew/bin/tunnel-client",
    "    run", "    --profile-file", "    " + profileFile,
    "  }", "  runs = " + runs, "  pid = " + pid, "}",
  ].join("\n");
}
function baseline() {
  return {
    managed: false, configured: false, status: "disabled", tunnel_id: null,
    health_port: 8080, pid: null, started_at: null, last_ready_at: null,
    last_exit_at: null, last_exit_code: null, restarts: 0,
    reused_external: false, last_error: null, log_tail: "",
  };
}
function mock(overrides = {}) {
  const calls = { job: 0, read: 0, ready: 0 };
  const deps = {
    platform: "darwin", home, uid: 501, ttlMs: 4000,
    async launchctlPrint(label) {
      calls.job++;
      assert.equal(label, "gui/501/com.localchatgpt.plus.tunnel");
      return job();
    },
    async readProfile(file) {
      calls.read++;
      assert.equal(file, profileFile);
      return profile;
    },
    async ready(port) {
      calls.ready++;
      assert.equal(port, 8090);
      return true;
    },
    ...overrides,
  };
  return { calls, resolve: createDashboardTunnelResolver(3000, deps) };
}
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log("OK  " + name);
}
await test("verified launchd reports ONLINE and actual health port", async () => {
  const { resolve } = mock();
  const r = await resolve(baseline());
  assert.equal(r.status, "online");
  assert.equal(r.management, "launchd");
  assert.equal(r.health_port, 8090);
  assert.equal(r.pid, 1234);
  assert.equal(r.managed, false);
  assert.equal(r.restarts, 0);
  assert.ok(!JSON.stringify(r).includes(token), "secret leaked to Admin");
});
await test("nonrunning job or unhealthy /readyz never reports ONLINE", async () => {
  const stopped = mock({ launchctlPrint: async () => job("waiting", 0, 3) });
  const r = await stopped.resolve(baseline());
  assert.equal(r.management, "launchd");
  assert.equal(r.status, "stopped");
  assert.equal(r.restarts, 2);
  const failed = mock({ ready: async () => false });
  assert.equal((await failed.resolve(baseline())).status, "degraded");
});
await test("unverified job, profile, port or platform preserves disabled supervisor", async () => {
  for (const overrides of [
    { launchctlPrint: async () => job("running", 1234, 1, home + "/wrong.plist") },
    { readProfile: async () => profile.replace("127.0.0.1:3000/mcp", "127.0.0.1:3999/mcp") },
    { readProfile: async () => profile.replace("127.0.0.1:8090", "0.0.0.0:8090") },
    { launchctlPrint: async () => { throw new Error("job not found"); } },
    { platform: "linux" },
  ]) {
    const { resolve } = mock(overrides);
    const r = await resolve(baseline());
    assert.equal(r.status, "disabled");
    assert.equal(r.management, "not_monitored");
    assert.equal(r.health_port, 8080);
  }
});
await test("internal supervisor takes precedence without inspecting launchd", async () => {
  const { resolve, calls } = mock();
  const r = await resolve({ ...baseline(), managed: true, status: "online" });
  assert.equal(r.management, "internal");
  assert.equal(calls.job, 0);
});
await test("concurrent requests deduplicate and respect TTL", async () => {
  let now = 1000;
  const { resolve, calls } = mock({ now: () => now });
  await Promise.all(Array.from({ length: 5 }, () => resolve(baseline())));
  assert.equal(calls.job, 1);
  assert.equal(calls.ready, 1);
  await resolve(baseline());
  assert.equal(calls.job, 1);
  now += 4100;
  await resolve(baseline());
  assert.equal(calls.job, 2);
});
await test("Admin labels launchd separately from disabled internal supervisor", async () => {
  const src = fs.readFileSync(path.join(root, "public/ui/app.js"), "utf8");
  const m = src.match(/function tunnelDisplay\(tunnel\) \{[\s\S]*?\n\}\n\nfunction renderRuntimeOverview/);
  assert.ok(m, "dashboard helper missing");
  const fn = vm.runInNewContext(m[0].replace(/\n\nfunction renderRuntimeOverview$/, "") + "\ntunnelDisplay;");
  const online = fn({ management: "launchd", status: "online", health_port: 8090, restarts: 0 });
  assert.equal(online.label, "ONLINE");
  assert.equal(online.detail, "launchd-managed · health :8090 · 0 restart(s)");
  assert.equal(online.healthy, true);
  assert.equal(fn(baseline()).label, "NOT MONITORED");
  assert.equal(fn({ managed: true, status: "online", health_port: 8080 }).label, "ONLINE");
  assert.ok(src.includes("tunnelDisplay(tunnel).detail"));
});
console.log("\n" + passed + " dashboard-tunnel tests passed");
