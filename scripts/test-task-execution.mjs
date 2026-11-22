import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-task-execution-"));
process.env.MCP_AGENT_TASK_STATE_DIR = path.join(root, "tasks");
process.env.MCP_WORKER_STATE_DIR = path.join(root, "workers");
process.env.MCP_OPERATION_STATE_DIR = path.join(root, "operations");
const store = await import("../dist/lib/agent-task-store.js");
const link = await import("../dist/lib/task-workspace.js");
const { summarizeTaskExecution } = await import("../dist/lib/task-execution.js");
const { inspectTaskGit } = await import("../dist/lib/task-git-evidence.js");
const { taskWithExecution, taskExecutionContext } = await import("../dist/lib/task-execution-context.js");
const { safeWorkerFailureReason } = await import("../dist/lib/worker-failure.js");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`OK  ${name}`);
  passed++;
}

try {
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "parallel-worktree");
  const foreign = path.join(root, "foreign");
  await fs.mkdir(repo, { recursive: true });
  await fs.mkdir(foreign);
  git(repo, "init", "-q");
  await fs.writeFile(path.join(repo, "README.md"), "fixture\n");
  git(repo, "add", "README.md");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  git(repo, "worktree", "add", "-q", "--detach", worktree);
  git(foreign, "init", "-q");

  let task;
  await test("unique unfinished task links across real Git worktrees, not arbitrary directories", async () => {
    task = await store.createAgentTask({ objective: "refactor", workspace: repo, plan: ["implement", "test"] });
    assert.equal(await link.resolveWorkerTaskId(repo), task.id);
    assert.equal(await link.resolveWorkerTaskId(await fs.realpath(repo)), task.id);
    assert.equal(await link.resolveWorkerTaskId(worktree), task.id);
    assert.equal(await link.resolveWorkerTaskId(worktree, task.id), task.id);
    assert.equal(await link.resolveWorkerTaskId(foreign), undefined);
    await assert.rejects(() => link.resolveWorkerTaskId(foreign, task.id), /outside agent task/);
    await assert.rejects(() => link.resolveWorkerTaskId(repo, "nonexistent"), /Unknown agent task/);
  });
  await test("agent command detection does not infer on arbitrary shell commands", async () => {
    assert.equal(link.isAgentRunnerCommand('/Users/example/.bun/bin/omp --cwd /foo --model X'), true);
    assert.equal(link.isAgentRunnerCommand('"/my tools/omp" run'), true);
    assert.equal(link.isAgentRunnerCommand("codex exec -p foo"), true);
    assert.equal(link.isAgentRunnerCommand('echo "omp run"'), false);
    assert.equal(link.isAgentRunnerCommand('python -m http.server'), false);
    assert.equal(link.isAgentRunnerCommand('pnpm dev'), false);
  });
  await test("ambiguous active tasks never get auto-linked", async () => {
    const other = await store.createAgentTask({ objective: "second", workspace: repo, plan: ["do"] });
    assert.equal(await link.resolveWorkerTaskId(repo), undefined);
    assert.equal(await link.resolveWorkerTaskId(worktree), undefined);
    assert.equal(await link.resolveWorkerTaskId(repo, task.id), task.id);
    await store.updateAgentTask(other.id, { status: "completed" });
    assert.equal(await link.resolveWorkerTaskId(worktree), task.id);
  });

  const ago = new Date(Date.now() - 30 * 60_000).toISOString();
  await test("execution state differentiates running, silent, stale, failed, blocked, and completed", async () => {
    const initial = { ...task, updated_at: ago };
    const input = { task: initial, processes: [], workers: [], operations: [], now: Date.now() };
    assert.equal(summarizeTaskExecution(input).state, "stalled");
    assert.equal(summarizeTaskExecution({ ...input, task: { ...initial, updated_at: new Date().toISOString() } }).state, "waiting");
    const recent = new Date().toISOString();
    const active = summarizeTaskExecution({ ...input, processes: [
      { id: "running", task_id: task.id, running: true, last_activity_at: recent },
      { id: "unrelated", task_id: "else", running: true },
    ] });
    assert.equal(active.state, "running");
    assert.equal(active.running_worker_count, 1);
    const silent = summarizeTaskExecution({ ...input, processes: [
      { id: "running", task_id: task.id, running: true, last_activity_at: ago },
    ] });
    assert.equal(silent.state, "running", "silence alone must not kill an active worker");
    assert.ok(silent.warnings.some((w) => w.includes("no captured output")));
    const failure = summarizeTaskExecution({ ...input, workers: [{
      id: "failed-worker", source: "omp-subagent", kind: "subagent", parent_task_id: task.id,
      status: "failed", lifecycle_owner: "local-mcp", started_at: ago, updated_at: recent,
      reason: "Timed out",
    }] });
    assert.equal(failure.state, "stalled");
    assert.equal(failure.last_worker_exit.reason, "Timed out");
    assert.match(failure.recovery, /failed_worker/);
    assert.equal(summarizeTaskExecution({ ...input, task: { ...initial, status: "blocked" } }).state, "blocked");
    assert.equal(summarizeTaskExecution({ ...input, task: { ...initial, status: "completed" } }).state, "completed");
  });
  await test("Git evidence warns about task-plan drift without completing any steps", async () => {
    const gitEvidence = await inspectTaskGit(repo);
    assert.ok(gitEvidence?.head);
    const newer = { ...gitEvidence, committed_at: new Date().toISOString() };
    const stale = { ...task, updated_at: ago };
    const result = summarizeTaskExecution({ task: stale, processes: [], workers: [], operations: [], git: newer });
    assert.equal(result.progress_may_be_out_of_sync, true);
    assert.ok(result.warnings.some((w) => w.includes("commit does not prove")));
    assert.equal(task.steps.every((s) => s.status === "pending"), true);
  });
  await test("durable verification checkpoints and failure receipts never advance plan progress", async () => {
    const before = (await store.getAgentTask(task.id)).updated_at;
    await store.recordTaskVerification(task.id, {
      passed: true, checks: 3, failures: 0, preset: "full", git_head: "a".repeat(40), dirty: false,
    });
    await store.recordTaskWorkerEvent(task.id, {
      worker_id: "worker-123", kind: "process", outcome: "failed", reason: "Exit code 1",
    });
    const saved = await store.getAgentTask(task.id);
    assert.equal(saved.status, "active");
    assert.equal(saved.steps.filter((s) => s.status === "completed").length, 0);
    assert.equal(saved.verification_checkpoints.length, 1);
    assert.equal(saved.worker_events.length, 1);
    assert.equal(saved.worker_events[0].reason, "Exit code 1");
    const checkpointAt = saved.updated_at;
    await store.recordTaskWorkerEvent(task.id, { worker_id: "worker-124", kind: "process", outcome: "completed" });
    assert.equal((await store.getAgentTask(task.id)).updated_at, checkpointAt,
      "worker completion is not a verification/plan checkpoint");
    assert.ok(Date.parse(checkpointAt) >= Date.parse(before));
    const context = await taskExecutionContext();
    const result = await taskWithExecution(saved, context);
    assert.equal(result.execution.state, "stalled");
    assert.ok(result.execution.warnings.some((w) => w.includes("differs from its last successful verification")));
  });
  await test("provider failure classification never persists API key text", async () => {
    const result = safeWorkerFailureReason("401 Invalid API key: secret-should-not-appear", "exit 1");
    assert.match(result, /authentication rejected/);
    assert.doesNotMatch(result, /secret-should-not-appear/);
    assert.equal(safeWorkerFailureReason("generic error", "exit 1"), "exit 1");
  });
  await test("explicit reactivation is required for terminal tasks and foreign task IDs", async () => {
    await store.updateAgentTask(task.id, { status: "completed" });
    await assert.rejects(() => link.resolveWorkerTaskId(repo, task.id), /reactivate/);
    assert.equal(await link.resolveWorkerTaskId(repo), undefined);
  });
  git(repo, "worktree", "remove", "--force", worktree);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
console.log(`\n${passed} passed, 0 failed`);
