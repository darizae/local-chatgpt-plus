/** Never-ready child regression, isolated from the production service. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createTunnelSupervisor } from "../dist/lib/tunnel-supervisor.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcp-tunnel-supervisor-test-"));
const server = createServer((_req, res) => { res.writeHead(503); res.end("not ready"); });
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
const executable = path.join(root, "fake-tunnel-client");
await fs.writeFile(executable, "#!" + process.execPath + "\nsetInterval(() => {}, 1000);\n", { mode: 0o700 });
const env = {
  LOCAL_CODER_MANAGE_TUNNEL: "1",
  LCP_SYSTEMD_TUNNEL_MONITOR: "0",
  OPENAI_TUNNEL_ID: "test-tunnel",
  OPENAI_TUNNEL_API_KEY: "synthetic-test-only",
  OPENAI_TUNNEL_HEALTH_PORT: String(port),
  OPENAI_TUNNEL_CLIENT: executable,
};
const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
const supervisor = createTunnelSupervisor({ root, mcpPort: 3000, startupGraceMs: 50 });
try {
  await supervisor.start();
  const firstPid = supervisor.snapshot().pid;
  assert.ok(firstPid);
  const deadline = Date.now() + 8000;
  while (supervisor.snapshot().restarts === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(supervisor.snapshot().restarts >= 1, "never-ready child was not restarted");
  assert.throws(() => process.kill(firstPid, 0), { code: "ESRCH" });
  await supervisor.stop();
  assert.equal(supervisor.snapshot().status, "stopped");
  assert.equal(supervisor.snapshot().pid, null);
  console.log("OK never-ready managed child is reaped, restarted, and explicit stop cancels recovery");
  if (process.platform === "linux") {
    process.env.LCP_SYSTEMD_TUNNEL_MONITOR = "1";
    const external = createTunnelSupervisor({ root, mcpPort: 8766 });
    await external.start();
    assert.equal(external.snapshot().managed, false);
    assert.equal(external.snapshot().pid, null);
    await external.stop();
    console.log("OK systemd opt-in prevents competing internal supervisor");
  }
} finally {
  await supervisor.stop();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
