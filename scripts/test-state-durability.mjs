/** R3 state-durability + failure-injection fixtures (disposable state dirs only). */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { atomicWriteText } from "../dist/lib/atomic-file.js";
import {
  createAgentTask,
  getResumableAgentTask,
  listAgentTasks,
} from "../dist/lib/agent-task-store.js";
import {
  recordOperationStart,
  recordOperationFinish,
  getOperationRecord,
} from "../dist/lib/operation-store.js";
import {
  createCodingLoop,
  listCodingLoops,
  getCodingLoopStateErrors,
  newCodingLoopId,
} from "../dist/lib/coding-loop-store.js";
import { saveParallelBatch, loadParallelBatch, newParallelBatchId } from "../dist/lib/parallel-batch-store.js";
import { saveIdempotent, loadIdempotent, requestFingerprint } from "../dist/lib/idempotency-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lcp-state-durability-"));

let passed = 0;
function ok(name) { console.log(`OK  ${name}`); passed++; }
async function expectThrows(fn, re, name) {
  let threw = false;
  try { await fn(); } catch (err) {
    threw = true;
    if (re && !re.test(String(err?.message ?? err))) throw new Error(`${name}: unexpected error ${err?.message}`);
  }
  if (!threw) throw new Error(`${name}: expected to throw`);
  ok(name);
}

const dirs = {
  tasks: path.join(tmp, "tasks"),
  ops: path.join(tmp, "operations"),
  loops: path.join(tmp, "loops"),
  batches: path.join(tmp, "batches"),
  idem: path.join(tmp, "idempotency"),
};
const prev = {};
for (const key of Object.keys(dirs)) {
  const envKey = `MCP_${key === "idem" ? "IDEMPOTENCY" : key === "ops" ? "OPERATION" : key === "loops" ? "CODING_LOOP" : key === "batches" ? "PARALLEL_BATCH" : "AGENT_TASK"}_STATE_DIR`;
  prev[key] = process.env[envKey];
  process.env[envKey] = dirs[key];
}

function codingLoopRecord(overrides = {}) {
  const id = overrides.id ?? newCodingLoopId();
  const now = new Date().toISOString();
  return {
    id,
    goal: "test",
    status: "active",
    phase: "editing",
    source_workspace: root,
    workspace: root,
    transaction_id: "tx-test",
    verification: { preset: "quick", stop_on_failure: true },
    max_attempts: 3,
    attempts: [],
    context: { refreshed_at: now, fingerprint: "x", project: { name: "x", root, git: {}, scripts: [] }, languages: [], important_files: [], scanned_files: 0, scan_truncated: false },
    isolation: { mode: "none", source_workspace: root, workspace: root },
    notes: [],
    ...overrides,
  };
}

function batchRecord() {
  return {
    version: 1,
    id: newParallelBatchId(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    concurrency: 1,
    commands: [{ command: "echo hi" }],
    results: [null],
    attempts: 0,
  };
}

async function listTmpFiles(dir) {
  return (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

try {
  // 1. Durable atomic write leaves no temp file and full content survives.
  {
    const target = path.join(tmp, "atomic", "index.json");
    await atomicWriteText(target, JSON.stringify({ n: 1 }));
    const leftover = (await listTmpFiles(path.dirname(target))).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftover, [], "temp file left after durable write");
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf-8")), { n: 1 });
    // Overwrite: old content fully replaced, still atomic, no partial data.
    await atomicWriteText(target, JSON.stringify({ n: 2 }));
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf-8")), { n: 2 });
    ok("atomicWriteText leaves no temp file and fully replaces target");
  }

  // 2. Abort BEFORE rename (simulated crash leaves an orphan temp, target intact).
  {
    const dir = path.join(tmp, "atomic", "abort");
    const target = path.join(dir, "index.json");
    await atomicWriteText(target, "OLD");
    // A writer crashed before rename: only its temp was created.
    await fs.writeFile(path.join(dir, "index.json.999.deadbeef.tmp"), "PARTIAL");
    assert.equal(await fs.readFile(target, "utf-8"), "OLD", "abort before rename must not corrupt the committed target");
    // Next successful write still lands, orphan temp is harmless (unique temp name).
    await atomicWriteText(target, "NEW");
    assert.equal(await fs.readFile(target, "utf-8"), "NEW");
    ok("abort before rename preserves committed target; orphan temp harmless");
  }

  // 3. Subprocess crash mid-write: target is never partially written.
  {
    const dir = path.join(tmp, "atomic", "crash");
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, "index.json");
    const childScript = path.join(tmp, "atomic", "crash-writer.mjs");
    await fs.writeFile(childScript, `import { atomicWriteTextSync } from ${JSON.stringify(path.join(root, "dist/lib/atomic-file.js"))};
atomicWriteTextSync(process.argv[2], "D".repeat(Number(process.argv[3])));\n`);
    const payloadBytes = 40 * 1024 * 1024;
    const child = spawn(process.execPath, [childScript, target, String(payloadBytes)]);
    // Kill as soon as a temp file appears (i.e. before rename), or shortly after.
    const deadline = Date.now() + 5000;
    let killed = false;
    while (Date.now() < deadline && child.exitCode === null) {
      const temps = (await listTmpFiles(dir)).filter((n) => n.endsWith(".tmp"));
      if (temps.length > 0) { child.kill("SIGKILL"); killed = true; break; }
      await new Promise((r) => setTimeout(r, 5));
    }
    if (!killed) child.kill("SIGKILL");
    await new Promise((r) => child.on("close", r));
    const content = await fs.readFile(target, "utf-8").catch(() => null);
    if (content !== null) {
      // Rename is atomic: content is either absent or the complete payload, never partial.
      assert.equal(content.length, payloadBytes, "crash mid-write must never leave partial target");
    }
    assert.equal(killed, true, "fixture failed to interrupt writer");
    ok("subprocess killed mid-write leaves only absent or fully-written target");
  }

  // 4. Corrupted JSON: agent-task index fails loud (never silently purged).
  {
    const idx = path.join(dirs.tasks, "index.json");
    await fs.mkdir(dirs.tasks, { recursive: true });
    await fs.writeFile(idx, "{ not json", "utf-8");
    await expectThrows(() => listAgentTasks(), /JSON|Unexpected|Syntax/i, "corrupted agent-task index fails loud");
    await fs.rm(idx, { force: true });
  }

  // 5. Corrupted coding-loop file is isolated: other loops survive.
  {
    const good = await createCodingLoop(codingLoopRecord({ id: newCodingLoopId() }));
    const badId = newCodingLoopId();
    await fs.writeFile(path.join(dirs.loops, `${badId}.json`), "{ broken", "utf-8");
    const loops = await listCodingLoops();
    assert.ok(loops.some((l) => l.id === good.id), "valid loop lost when a sibling file is corrupted");
    assert.ok(!loops.some((l) => l.id === badId), "corrupted loop surfaced as a record");
    assert.ok(getCodingLoopStateErrors().some((e) => e.includes(badId)), "corrupted loop reported in state errors");
    ok("corrupted coding-loop file isolated; other loops and errors survive");
  }

  // 6. Stale active task with no worker: resumable task retained, running op marked interrupted.
  {
    const task = await createAgentTask({ objective: "durable", workspace: root });
    const resumed = await getResumableAgentTask(task.id);
    assert.ok(resumed, "active task with no worker must still be resumable");
    await recordOperationStart({ id: "op-stale", command: "sleep 1", cwd: root, status: "running", started_at: new Date().toISOString() });
    const stale = await getOperationRecord("op-stale", new Set());
    assert.equal(stale.effective_status, "interrupted", "running op with no live worker must be reported interrupted");
    const live = await getOperationRecord("op-stale", new Set(["op-stale"]));
    assert.equal(live.effective_status, "running", "op with a live worker must stay running");
    await recordOperationFinish("op-stale", { status: "failed" });
    ok("stale active task retained; running op without a worker marked interrupted");
  }

  // 7. Project race isolation: independent state dirs never cross-contaminate.
  {
    const dirB = path.join(tmp, "tasks-b");
    const saved = process.env.MCP_AGENT_TASK_STATE_DIR;
    process.env.MCP_AGENT_TASK_STATE_DIR = dirB;
    await createAgentTask({ objective: "project B", workspace: root });
    process.env.MCP_AGENT_TASK_STATE_DIR = saved;
    const a = await listAgentTasks();
    assert.ok(!a.some((t) => t.objective === "project B"), "project B task leaked into project A store");
    assert.ok(a.some((t) => t.objective === "durable"), "project A task missing after concurrent project write");
    process.env.MCP_AGENT_TASK_STATE_DIR = dirB;
    const b = await listAgentTasks();
    assert.equal(b.length, 1, "project B store contaminated");
    process.env.MCP_AGENT_TASK_STATE_DIR = saved;
    ok("independent state dirs are isolated across projects");
  }

  // 8. Concurrent in-process mutations lose no updates.
  {
    const saved = process.env.MCP_AGENT_TASK_STATE_DIR;
    process.env.MCP_AGENT_TASK_STATE_DIR = path.join(tmp, "tasks-conc");
    await Promise.all(Array.from({ length: 20 }, (_, i) => createAgentTask({ objective: `conc-${i}`, workspace: root })));
    const tasks = await listAgentTasks();
    assert.equal(tasks.length, 20, "concurrent task creation lost updates");
    process.env.MCP_AGENT_TASK_STATE_DIR = saved;
    ok("20 concurrent task creations all persisted (no lost update)");
  }

  // 9. Parallel batch + idempotency durable round-trip and fail-loud corruption.
  {
    const batch = batchRecord();
    await saveParallelBatch(batch);
    const loaded = await loadParallelBatch(batch.id);
    assert.equal(loaded.commands[0].command, "echo hi");
    const leftover = (await listTmpFiles(dirs.batches)).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftover, [], "parallel-batch temp file left behind");

    const key = "op:write:/tmp/x";
    const fp = requestFingerprint({ a: 1 });
    await saveIdempotent(key, fp, { delivered: true });
    assert.deepEqual(await loadIdempotent(key, fp), { delivered: true });
    await expectThrows(() => loadIdempotent(key, requestFingerprint({ a: 2 })), /already used/, "idempotency rejects a different fingerprint for the same key");
    ok("parallel batch and idempotency durable round-trip; idempotency rejects replays");
  }
} finally {
  for (const key of Object.keys(dirs)) {
    const envKey = `MCP_${key === "idem" ? "IDEMPOTENCY" : key === "ops" ? "OPERATION" : key === "loops" ? "CODING_LOOP" : key === "batches" ? "PARALLEL_BATCH" : "AGENT_TASK"}_STATE_DIR`;
    if (prev[key] === undefined) delete process.env[envKey];
    else process.env[envKey] = prev[key];
  }
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\nstate-durability: ${passed} fixtures passed`);
if (passed === 0) process.exitCode = 1;