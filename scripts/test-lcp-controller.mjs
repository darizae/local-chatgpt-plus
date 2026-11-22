#!/usr/bin/env node
/**
 * Deterministic regression tests for the `scripts/lcp` controller.
 *
 * Runs the real `scripts/lcp` script against an isolated state directory while
 * shadowing process-management commands (lsof, launchctl, curl, ps, sleep)
 * with small stubs that read/write a "world" JSON file. This gives
 * deterministic coverage of controller logic (Issue A mode consistency,
 * Issue B fail-closed OFF, Issue C accurate status) WITHOUT touching the live
 * launchd jobs or any running deployment.
 *
 * Run:  node scripts/test-lcp-controller.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LCP = path.join(ROOT, "scripts", "lcp");

const scratch = mkdtempSync(path.join(tmpdir(), "lcp-controller-test-"));
const STATE = path.join(scratch, "state");
const REPO = path.join(scratch, "repo");
const MOCK = path.join(scratch, "bin");
const WORLD = path.join(STATE, "mock-world.json");
const MODE_FILE = path.join(STATE, "state", "mode");
for (const d of [STATE, path.join(REPO, "dist"), MOCK]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(REPO, "dist", "index.js"), "# dummy build\n");
const nodeBin = path.join(MOCK, "node-bin"); // must be a real executable path
writeFileSync(nodeBin, "#!/usr/bin/env bash\nexit 0\n"); chmodSync(nodeBin, 0o755);
const tunnelBin = path.join(MOCK, "tunnel-client");
writeFileSync(tunnelBin, "#!/usr/bin/env bash\nexit 0\n"); chmodSync(tunnelBin, 0o755);
const tunnelYaml = path.join(scratch, "tunnel.yaml");
writeFileSync(tunnelYaml, "profile: test\n");

function writeWorld(world) {
  writeFileSync(WORLD, JSON.stringify(world));
}
function readWorld() {
  return JSON.parse(readFileSync(WORLD, "utf-8"));
}
function readMode() {
  try {
    return readFileSync(MODE_FILE, "utf-8").trim();
  } catch {
    return null;
  }
}
function writeMode(value) {
  mkdirSync(path.dirname(MODE_FILE), { recursive: true });
  writeFileSync(MODE_FILE, `${value}\n`);
}

/** An empty world (everything off). */
function emptyWorld() {
  return { ports: {}, jobs: {}, processes: {}, health: { on: false, body: {} }, ready: false, retain_jobs: {}, retain_ports: {} };
}

// ---------------------------------------------------------------------------
// Mock command stubs
// ---------------------------------------------------------------------------
const MUTATE = path.join(MOCK, "mutate.mjs");
writeFileSync(MUTATE, `
import fs from "node:fs";
const [,, action, label, profile] = process.argv;
const W = process.env.LCP_MOCK_WORLD;
const w = JSON.parse(fs.readFileSync(W, "utf-8"));
const nextPid = () => 5000 + Object.keys(w.processes).length * 7;
const permFor = (p) => p === "open" ? "open:full machine"
  : p === "custom" ? "custom:roots=/tmp/repos" : "workspace:roots=/tmp";
if (action === "bootstrap") {
  const pid = nextPid();
  w.jobs[label] = { loaded: true, pid };
  w.processes[pid] = { ppid: 0 };
  if (label.includes("server")) {
    w.ports["3000"] = { pid };
    w.ports["3001"] = { pid };
    w.health = { on: true, body: { status: "ok", authMode: "oauth", permission: permFor(profile), fullMachineAccess: profile === "open", workspace: "/tmp" } };
  } else {
    w.ports["8090"] = { pid };
    w.ready = true;
  }
} else if (action === "bootout") {
  if (!w.retain_jobs[label]) {
    const pid = w.jobs[label]?.pid;
    if (pid != null && !w.retain_ports[label]) {
      for (const [port, rec] of Object.entries(w.ports)) {
        if (rec.pid === pid) delete w.ports[port];
      }
    }
    w.jobs[label].loaded = false;
  }
}
fs.writeFileSync(W, JSON.stringify(w));
`);
chmodSync(MUTATE, 0o755);

function stub(name, body) {
  const p = path.join(MOCK, name);
  writeFileSync(p, `#!/usr/bin/env bash\nexport LCP_MOCK_WORLD="${WORLD}"\n${body}\n`);
  chmodSync(p, 0o755);
}

stub("lsof", `
port=""
for a in "$@"; do case "$a" in -iTCP:*) port="\${a#-iTCP:}";; esac; done
[ -z "$port" ] && exit 0
pid=$(jq -r --arg p "$port" '.ports[$p].pid // empty' "\$LCP_MOCK_WORLD" 2>/dev/null)
[ -n "$pid" ] && echo "$pid"
exit 0
`);

stub("launchctl", `
cmd="$1"; shift
case "$cmd" in
  print)
    label="\${1##*/}"
    loaded=$(jq -r --arg l "$label" '.jobs[$l].loaded // false' "\$LCP_MOCK_WORLD")
    if [ "$loaded" = "true" ]; then
      pid=$(jq -r --arg l "$label" '.jobs[$l].pid // 0' "\$LCP_MOCK_WORLD")
      printf '\\n        state = running\\n        pid = %s\\n' "$pid"
      exit 0
    fi
    exit 1
    ;;
  bootstrap)
    plist="\${@: -1}"
    label=$(basename "$plist" .plist)
    perms=$(sed -n 's#.*<key>PERMISSIONS_CONFIG</key>.*<string>\\([^<]*\\)</string>.*#\\1#p' "$plist" | head -1)
    profile=""
    if [ -n "$perms" ] && [ -f "$perms" ]; then profile=$(jq -r '.profile // ""' "$perms" 2>/dev/null); fi
    node "${MUTATE}" bootstrap "$label" "$profile"
    exit 0
    ;;
  bootout)
    label="\${1##*/}"
    node "${MUTATE}" bootout "$label"
    exit 0
    ;;
esac
exit 1
`);

stub("curl", `
url=""
for a in "$@"; do case "$a" in http://*) url="$a";; esac; done
port=$(printf '%s' "$url" | sed -E 's#http://127\\.0\\.0\\.1:([0-9]+)/.*#\\1#')
ep=$(printf '%s' "$url" | sed -E 's#http://127\\.0\\.0\\.1:[0-9]+(/[^?]*)#\\1#')
if [ "$port" = "3000" ] && [ "$ep" = "/health" ]; then
  on=$(jq -r '.health.on // false' "\$LCP_MOCK_WORLD")
  if [ "$on" = "true" ]; then jq -c '.health.body' "\$LCP_MOCK_WORLD"; exit 0; fi
  exit 22
fi
if [ "$port" = "8090" ] && [ "$ep" = "/readyz" ]; then
  r=$(jq -r '.ready // false' "\$LCP_MOCK_WORLD")
  if [ "$r" = "true" ]; then echo "ready ok"; exit 0; fi
  exit 22
fi
exit 22
`);

stub("ps", `
pid=""
for a in "$@"; do case "$a" in ([0-9]*) pid="$a";; esac; done
[ -z "$pid" ] && exit 0
ppid=$(jq -r --arg p "$pid" '.processes[$p].ppid // empty' "\$LCP_MOCK_WORLD" 2>/dev/null)
[ -n "$ppid" ] && echo "$ppid"
exit 0
`);

stub("sleep", `exit 0`); // make wait_for loops instant and deterministic

const OPEN_LOG = path.join(scratch, "open-log.txt");
stub("open", `
url=""
for a in "$@"; do case "$a" in http://*) url="$a";; esac; done
printf '%s\\n' "$url" >> "$LCP_MOCK_OPEN_LOG"
exit 0
`);

const baseEnv = {
  LCP_STATE_DIR: STATE,
  LCP_REPO: REPO,
  LCP_NODE_BIN: nodeBin,
  LCP_TUNNEL_BIN: tunnelBin,
  LCP_TUNNEL_YAML: tunnelYaml,
  LCP_MOCK_WORLD: WORLD,
  LCP_MOCK_OPEN_LOG: OPEN_LOG,
  LCP_WORKSPACE_ROOT: "/tmp",
  LCP_PROJECT_ROOT_1: "/tmp/repos",
  LCP_PROJECT_ROOT_2: "/tmp/Downloads",
  LCP_PROJECT_ROOT_3: "/tmp/disposable",
  PATH: `${MOCK}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: scratch,
  USER: "tester",
};

function runLcp(args, env = {}) {
  return spawnSync(LCP, args, {
    encoding: "utf-8",
    env: { ...baseEnv, ...env },
  });
}

/** Build a world where the server+tunnel are ON and owned by the controller. */
function onWorld(opts = {}) {
  const w = emptyWorld();
  const spid = opts.serverPid ?? 111;
  w.jobs["com.localchatgpt.plus.server"] = { loaded: true, pid: spid };
  w.jobs["com.localchatgpt.plus.tunnel"] = { loaded: true, pid: 222 };
  w.processes[spid] = { ppid: 0 };
  w.processes[222] = { ppid: 0 };
  w.ports["3000"] = { pid: spid };
  w.ports["3001"] = { pid: opts.adminPid ?? spid };
  w.ports["8090"] = { pid: 222 };
  w.health = { on: true, body: { status: "ok", authMode: "oauth", permission: opts.permission ?? "open:full machine", fullMachineAccess: true, workspace: "/tmp" } };
  w.ready = true;
  if (opts.retain_jobs) w.retain_jobs = opts.retain_jobs;
  if (opts.retain_ports) w.retain_ports = opts.retain_ports;
  return w;
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(String(err && err.message || err));
  }
}

// ---------------------------------------------------------------------------
// Issue A — already-ON mode consistency
// ---------------------------------------------------------------------------

test("ON already running in the SAME mode is an idempotent no-op", () => {
  writeWorld(onWorld({ permission: "open:full machine" }));
  writeMode("full");
  const out = runLcp(["on", "--mode", "full"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /already ON in mode full/);
  assert.equal(readMode(), "full");
});

test("ON already running in a DIFFERENT mode refuses and keeps stored mode (Full running, plain `lcp on`)", () => {
  writeWorld(onWorld({ permission: "open:full machine" }));
  writeMode("full");
  const out = runLcp(["on"]); // defaults to workspace
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /running mode is 'full'/);
  assert.match(out.stderr, /lcp mode workspace/);
  assert.equal(readMode(), "full"); // stored mode untouched
});

test("ON already running workspace + `--mode projects` refuses without a switch", () => {
  writeWorld(onWorld({ permission: "workspace:roots=/tmp" }));
  writeMode("workspace");
  const out = runLcp(["on", "--mode", "projects"]);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /lcp mode projects/);
  assert.equal(readMode(), "workspace");
});

test("Fresh ON in workspace succeeds end to end (server + tunnel bootstrapped)", () => {
  writeWorld(emptyWorld());
  const out = runLcp(["on"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /ON — mode=workspace/);
  const w = readWorld();
  assert.equal(w.jobs["com.localchatgpt.plus.server"].loaded, true);
  assert.equal(w.jobs["com.localchatgpt.plus.tunnel"].loaded, true);
  assert.equal(readMode(), "workspace");
});

function readOpenLog() {
  try {
    return readFileSync(OPEN_LOG, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
function resetOpenLog() {
  writeFileSync(OPEN_LOG, "");
}

test("Fresh `lcp on` opens the Admin dashboard exactly once (forced-interactive)", () => {
  resetOpenLog();
  writeWorld(emptyWorld());
  const out = runLcp(["on"], { LCP_OPEN_DASHBOARD: "1" }); // force the interactive path
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /ON — mode=workspace/);
  assert.match(out.stdout, /Opened Admin dashboard/);
  const opens = readOpenLog();
  assert.equal(opens.length, 1);
  assert.equal(opens[0], "http://127.0.0.1:3001/ui");
});

test("Non-interactive `lcp on` does not auto-open the dashboard", () => {
  resetOpenLog();
  writeWorld(emptyWorld());
  const out = runLcp(["on"]); // no TTY, LCP_OPEN_DASHBOARD unset -> must not open
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /Opened Admin dashboard/);
  assert.equal(readOpenLog().length, 0);
});

test("`lcp on` with LCP_OPEN_DASHBOARD=0 never opens even when interactive-forced", () => {
  resetOpenLog();
  writeWorld(emptyWorld());
  const out = runLcp(["on"], { LCP_OPEN_DASHBOARD: "0" });
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /Opened Admin dashboard/);
  assert.equal(readOpenLog().length, 0);
});

test("Repeated `lcp on` while already ON does not open a duplicate dashboard tab", () => {
  resetOpenLog();
  writeWorld(onWorld({ permission: "workspace:roots=/tmp" }));
  writeMode("workspace");
  const out = runLcp(["on"], { LCP_OPEN_DASHBOARD: "1" }); // already ON -> no-op, no open
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /already ON/);
  assert.doesNotMatch(out.stdout, /Opened Admin dashboard/);
  assert.equal(readOpenLog().length, 0);
});

test("Auto-open guards against wrong-port and disabled Admin UI", () => {
  const src = readFileSync(LCP, "utf8");
  // open_dashboard only runs after the Admin UI actually listens on the exact
  // ADMIN_PORT constant (no wildcard guess); a missing/disabled admin times out
  // with a warning instead of opening an arbitrary URL.
  if (!/wait_for 20 admin_ready/.test(src)) throw new Error("auto-open must wait for admin_ready on the configured ADMIN_PORT");
  if (!/admin_ready\(\) \{[^}]*listener_pid "\$ADMIN_PORT"/.test(src)) throw new Error("admin_ready must trust only the configured ADMIN_PORT listener");
  if (!/Admin dashboard not ready/.test(src)) throw new Error("missing graceful skip message when Admin UI is unavailable");
  // Exactly-once: opening is gated on a fresh server start (started_server=yes)
  // and on LCP_ALLOW_OPEN=1, which only direct `lcp on` sets.
  if (!/started_server" = "yes" \]/.test(src)) throw new Error("auto-open must be gated on a fresh server start");
  if (!/LCP_ALLOW_OPEN=1/.test(src)) throw new Error("only direct `lcp on` may allow auto-open");
});

test("`lcp restart` and `lcp mode` never auto-open the dashboard", () => {
  resetOpenLog();
  writeWorld(emptyWorld());
  const out = runLcp(["restart"], { LCP_OPEN_DASHBOARD: "1" });
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /Opened Admin dashboard/);
  assert.equal(readOpenLog().length, 0);

  resetOpenLog();
  writeWorld(onWorld({ permission: "workspace:roots=/tmp" }));
  writeMode("workspace");
  const out2 = runLcp(["mode", "projects"], { LCP_OPEN_DASHBOARD: "1" });
  assert.equal(out2.status, 0, out2.stderr);
  assert.doesNotMatch(out2.stdout, /Opened Admin dashboard/);
  assert.equal(readOpenLog().length, 0);
});

test("Projects Shortcut switches via `lcp mode projects` when workspace is already ON", () => {
  writeWorld(onWorld({ permission: "workspace:roots=/tmp" }));
  writeMode("workspace");
  const out = runLcp(["mode", "projects"]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(readMode(), "projects");
  const w = readWorld();
  assert.equal(w.health.body.permission, "custom:roots=/tmp/repos"); // profile switched
});

test("Full mode requires explicit confirmation and is never silently enabled", () => {
  writeWorld(emptyWorld());
  rmSync(MODE_FILE, { force: true });
  const out = runLcp(["on", "--mode", "full"]); // non-interactive, LCP_FULL_CONFIRM unset
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /FULL\/YOLO/);
  const w = readWorld();
  assert.equal(Boolean(w.jobs["com.localchatgpt.plus.server"]?.loaded), false); // nothing started
  assert.equal(readMode(), null);
});

test("Full mode starts with LCP_FULL_CONFIRM=1", () => {
  writeWorld(emptyWorld());
  const out = runLcp(["on", "--mode", "full"], { LCP_FULL_CONFIRM: "1" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /ON — mode=full/);
  assert.equal(readMode(), "full");
});

// ---------------------------------------------------------------------------
// Issue B — OFF fails closed
// ---------------------------------------------------------------------------

test("OFF succeeds only when jobs are unloaded and all ports closed", () => {
  writeWorld(onWorld({ permission: "open:full machine" }));
  writeMode("full");
  const out = runLcp(["off"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /OFF — MCP and tunnel stopped/);
  const w = readWorld();
  assert.equal(w.jobs["com.localchatgpt.plus.server"].loaded, false);
  assert.equal(w.jobs["com.localchatgpt.plus.tunnel"].loaded, false);
  assert.equal(Object.keys(w.ports).length, 0);
  assert.equal(readMode(), null); // mode cleared
});

test("Idempotent OFF when already off", () => {
  writeWorld(emptyWorld());
  const out = runLcp(["off"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /OFF —/);
});

test("OFF reports ERROR when an admin-port listener survives server stop", () => {
  const w = onWorld({ permission: "open:full machine", adminPid: 999 });
  w.processes[999] = { ppid: 5500 }; // unrelated process
  writeWorld(w);
  const out = runLcp(["off"]);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /ERROR — OFF incomplete/);
  assert.match(out.stderr, /port=3001/);
  // unrelated process untouched
  assert.equal(readWorld().ports["3001"].pid, 999);
});

test("OFF reports ERROR when a controller-owned tunnel listener survives unload", () => {
  // Owned tunnel job is unloaded, but its readiness port stays bound
  // (e.g. a child that briefly keeps the listener open) -> OFF must report it.
  const w = onWorld({
    permission: "open:full machine",
    retain_ports: { "com.localchatgpt.plus.tunnel": true },
  });
  writeWorld(w);
  const out = runLcp(["off"]);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /ERROR — OFF incomplete/);
  assert.match(out.stderr, /port=8090/);
});

test("OFF refuses when a tunnel port is served by an unrelated process", () => {
  // An unmanaged process owns the readiness port; OFF must not claim it could
  // stop it, and must direct the operator to migrate instead.
  const w = onWorld({ permission: "open:full machine" });
  w.ports["8090"] = { pid: 777 };
  w.processes[777] = { ppid: 5501 };
  writeWorld(w);
  const out = runLcp(["off"]);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /lcp migrate/);
});

test("OFF reports ERROR when a launchd job remains loaded", () => {
  const w = onWorld({ permission: "open:full machine", retain_jobs: { "com.localchatgpt.plus.server": true } });
  writeWorld(w);
  const out = runLcp(["off"]);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /server-job/);
});

test("OFF does not kill or drain unrelated processes", () => {
  const w = onWorld({ permission: "open:full machine", retain_jobs: { "com.localchatgpt.plus.tunnel": true } });
  w.processes[999] = { ppid: 5500 };
  w.ports["3001"] = { pid: 999 };
  writeWorld(w);
  const before = Object.keys(w.processes);
  runLcp(["off"]);
  const after = Object.keys(readWorld().processes);
  assert.equal(before.join(","), after.join(","));
});

// ---------------------------------------------------------------------------
// Issue C — accurate status diagnostics
// ---------------------------------------------------------------------------

test("Status reports stored vs actual mode agreement when they match", () => {
  writeWorld(onWorld({ permission: "open:full machine" }));
  writeMode("full");
  const out = runLcp(["status"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Stored mode:          full/);
  assert.match(out.stdout, /Actual runtime mode:  full/);
  assert.match(out.stdout, /Mode agreement:       yes/);
  assert.doesNotMatch(out.stdout, /Restart\/switch pending: YES/);
});

test("Status flags stored/actual mode disagreement (stored=full, running=workspace)", () => {
  writeWorld(onWorld({ permission: "workspace:roots=/tmp" }));
  writeMode("full");
  const out = runLcp(["status"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Mode agreement:       NO/);
  assert.match(out.stdout, /Restart\/switch pending: YES/);
});

test("Status attributes the Admin UI port (3001) to the MCP server process, not 'unrelated'", () => {
  writeWorld(onWorld({ permission: "open:full machine" }));
  writeMode("full");
const out = runLcp(["status"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Port 3001:       listener pid 111 \(controller-owned \(shares MCP server pid 111\)\)/);
});

test("Status marks an unmanaged admin listener as UNMANAGED", () => {
  const w = onWorld({ permission: "open:full machine", adminPid: 999 });
  w.processes[999] = { ppid: 5500 };
  writeWorld(w);
  writeMode("full");
  const out = runLcp(["status"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Port 3001:       listener pid 999 \(UNMANAGED\)/);
});

// ---------------------------------------------------------------------------
// Phase 7C — owned delegated workers and fail-closed OFF
// ---------------------------------------------------------------------------

const WORKER_DIR = path.join(REPO, ".mcp-state", "workers");
function writeWorkers(workers) {
  mkdirSync(WORKER_DIR, { recursive: true });
  writeFileSync(path.join(WORKER_DIR, "index.json"), JSON.stringify({ version: 1, workers }));
}

test("Status reports a non-terminal owned worker", () => {
  writeWorld(onWorld({ permission: "workspace:roots=/tmp" }));
  writeWorkers([
    { id: "w-1", source: "omp-subagent", kind: "subagent", status: "running", lifecycle_owner: "local-mcp" },
    { id: "w-2", source: "omp-subagent", kind: "subagent", status: "completed", lifecycle_owner: "local-mcp" },
    { id: "w-3", source: "omp-subagent", kind: "subagent", status: "running", lifecycle_owner: "other" },
  ]);
  const out = runLcp(["status"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Owned delegated workers:  1 non-terminal recorded/);
  assert.match(out.stdout, /w-1/);
});

test("OFF fails closed (PARTIAL) while an owned worker is still recorded active", () => {
  writeWorld(onWorld({ permission: "workspace:roots=/tmp" }));
  writeWorkers([
    { id: "w-live", source: "omp-subagent", kind: "subagent", status: "running", lifecycle_owner: "local-mcp" },
  ]);
  const out = runLcp(["off"]);
  assert.equal(out.status, 2, `expected nonzero exit, got stdout=${out.stdout} stderr=${out.stderr}`);
  assert.match(out.stderr, /PARTIAL/);
  assert.match(out.stderr, /w-live/);
  assert.doesNotMatch(out.stdout, /^lcp: OFF — MCP and tunnel stopped/m);
});

test("OFF succeeds and reports no owned workers when the registry is clear", () => {
  writeWorld(onWorld({ permission: "workspace:roots=/tmp" }));
  writeWorkers([
    { id: "w-done", source: "omp-subagent", kind: "subagent", status: "completed", lifecycle_owner: "local-mcp" },
  ]);
  const out = runLcp(["off"]);
  assert.equal(out.status, 0, `${out.stdout} ${out.stderr}`);
  assert.match(out.stdout, /no owned workers remain/);
});

test("OFF with a missing/absent worker registry still succeeds", () => {
  writeWorld(onWorld({ permission: "workspace:roots=/tmp" }));
  const out = runLcp(["off"]);
  assert.equal(out.status, 0, `${out.stdout} ${out.stderr}`);
  assert.match(out.stdout, /no owned workers remain/);
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);