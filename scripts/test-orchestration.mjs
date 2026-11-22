#!/usr/bin/env node
/**
 * Orchestration layer tests (7C worker registry + 7A/7B readiness):
 *  - durable worker registry: register → list → status → owned → cancel guard
 *    → reconcile-on-restart → remove/prune, over an isolated state dir;
 *  - subagent/computer-use readiness is a precise, non-secret,
 *    server-observable status (no inferred scope grants, no credential leak).
 *
 * Run:  node scripts/test-orchestration.mjs   (after `npm run build`)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildOrchestrationReadiness,
  extractModelFromArgs,
} from "../dist/lib/orchestration-readiness.js";

// --- worker registry (isolated state dir) ---------------------------------
// Set the state dir BEFORE importing the worker registry so its module-level
// directory bootstrap uses the isolated path, not the repo default.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-reg-test-"));
process.env.MCP_WORKER_STATE_DIR = stateDir;
const {
  registerWorker,
  listWorkers,
  getWorker,
  updateWorkerStatus,
  ownedWorkers,
  reconcileOwnedWorkers,
  removeWorker,
} = await import("../dist/lib/worker-registry.js");

const w0 = await registerWorker({
  source: "omp-subagent",
  kind: "subagent",
  objective: "Resume Example Project T-016 preflight using DeepInfra",
  workspace: "/tmp/example-project",
  pid: 4242,
  provider: "deepinfra",
  model: "deepseek-ai/DeepSeek-V4-Flash-0731",
  cost_limit_cents: 100,
  timeout_ms: 60000,
});
assert.equal(w0.status, "running");
assert.equal(w0.source, "omp-subagent");
assert.equal(w0.lifecycle_owner, "local-mcp");

assert.equal((await listWorkers()).length, 1);
assert.ok((await ownedWorkers()).some((w) => w.id === w0.id));

// completion
const done = await updateWorkerStatus(w0.id, "completed", { finished: true });
assert.equal(done.status, "completed");
assert.ok(done.finished_at);
assert.ok((await ownedWorkers()).every((w) => w.id !== w0.id), "terminal worker no longer owned");

// cancel must not be clobbered by a late failure
const w1 = await registerWorker({ source: "omp-subagent", kind: "subagent", objective: "b" });
await updateWorkerStatus(w1.id, "cancelled", { reason: "operator" });
await updateWorkerStatus(w1.id, "failed", { reason: "late crash" });
assert.equal((await getWorker(w1.id)).status, "cancelled");

// restart reconciliation: a worker left running is honestly marked interrupted
const w2 = await registerWorker({ source: "omp-subagent", kind: "subagent", objective: "orphan" });
const reconciled = await reconcileOwnedWorkers();
assert.ok(reconciled >= 1);
assert.equal((await getWorker(w2.id)).status, "interrupted");
assert.match((await getWorker(w2.id)).reason, /restarted/i);

assert.equal(await removeWorker(w2.id), true);
assert.equal(await getWorker(w2.id), undefined);

// --- readiness (pure, non-secret) ------------------------------------------
const noSecretArgs = ["run", "--cwd", "{workspace}", "--model", "deepseek-ai/DeepSeek-V4-Flash-0731", "--max-cost", "100"];
const { provider, model } = extractModelFromArgs(noSecretArgs);
assert.equal(provider, "deepseek-ai");
assert.equal(model, "deepseek-ai/DeepSeek-V4-Flash-0731");

assert.deepEqual(extractModelFromArgs(["run", "{workspace}"]), { provider: null, model: null });

const disabled = buildOrchestrationReadiness({
  subagentConfig: {
    version: 1, enabled: false, executable: "", args: [], prompt_via_stdin: true,
    timeout_ms: 60000, max_concurrency: 4, isolation: "none",
  },
  upstreamServers: [],
  allowUnsafeRuntimes: true,
  permissionProfile: "open",
});
assert.equal(disabled.subagent.configured, false);
assert.match(disabled.subagent.hint, /not enabled/);
assert.equal(disabled.computer_use.scope_required, true);
assert.equal(disabled.computer_use.scope_grant_verified, "external");
assert.equal(disabled.computer_use.configured_provider_count, 0);
assert.match(disabled.computer_use.hint, /blocked/);

const enabled = buildOrchestrationReadiness({
  subagentConfig: {
    version: 1, enabled: true, executable: "/opt/example/bin/omp", args: noSecretArgs,
    prompt_via_stdin: true, timeout_ms: 60000, max_concurrency: 4, isolation: "none",
    env: { SOME_KEY: "should-never-surface" },
  },
  upstreamServers: [
    { id: "vercel-agent-desktop", name: "Vercel desktop", enabled: false, transport: "stdio", expose: "meta_only", tools: [], allowlist: [], command: "", args: [], cwd: "", env: {}, headers: {}, auth_type: "none" },
    { id: "vercel-agent-browser", name: "Vercel browser", enabled: true, transport: "http", expose: "all", tools: [], allowlist: [], command: "", args: [], cwd: "", url: "", env: {}, headers: {}, auth_type: "none" },
    { id: "unrelated", name: "unrelated", enabled: true, transport: "http", expose: "all", tools: [], allowlist: [], command: "", args: [], cwd: "", url: "", env: {}, headers: {}, auth_type: "none" },
  ],
  allowUnsafeRuntimes: true,
  permissionProfile: "open",
  subagentExecutableResolvable: true,
});
assert.equal(enabled.subagent.configured, true);
assert.equal(enabled.subagent.model, "deepseek-ai/DeepSeek-V4-Flash-0731");
assert.equal(enabled.subagent.provider, "deepseek-ai");
assert.equal(enabled.computer_use.configured_provider_count, 2);
assert.equal(enabled.computer_use.enabled_provider_count, 1);
assert.ok(!JSON.stringify(enabled).includes("should-never-surface"), "subagent env must never surface");

fs.rmSync(stateDir, { recursive: true, force: true });
console.log("orchestration: ok");