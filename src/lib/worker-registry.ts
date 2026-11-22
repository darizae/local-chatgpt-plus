/**
 * Durable record of independently-running, owned workers (e.g. OMP/model-backed
 * subagents). This is the 7C "worker registry" seam: it gives stable run IDs,
 * bounded status/lifecycle, and an honest answer to "what is owned and still
 * running?" so `lcp off` / the dashboard never mistake an owned worker for work
 * that has stopped. It is metadata only — cancellation of an owned worker still
 * goes through its real source (e.g. subagent-manager).
 */
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import { atomicWriteText } from "./atomic-file.js";

export type WorkerSource =
  | "omp-subagent"
  | "computer"
  | "chatgpt-direct"
  | "unknown";

export type WorkerStatus =
  | "queued"
  | "running"
  | "waiting_for_user"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface WorkerRecord {
  id: string;
  source: WorkerSource;
  kind: string; // "subagent" | "process" | ...
  status: WorkerStatus;
  objective?: string;
  workspace?: string;
  parent_task_id?: string;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  pid?: number;
  provider?: string;
  model?: string;
  cost_limit_cents?: number;
  cost_actual_cents?: number;
  timeout_ms?: number;
  lifecycle_owner: string; // e.g. "local-mcp"
  reason?: string; // safe status reason / cancellation note
}

interface WorkerIndex {
  version: 1;
  workers: WorkerRecord[];
}

const MAX_WORKERS = 300;
let mutationQueue: Promise<void> = Promise.resolve();
let cached: { path: string; value: WorkerIndex } | null = null;

function storeRoot(): string {
  return process.env.MCP_WORKER_STATE_DIR || path.resolve(process.cwd(), ".mcp-state", "workers");
}

function indexPath(): string {
  return path.join(storeRoot(), "index.json");
}

const EMPTY: WorkerIndex = { version: 1, workers: [] };

async function readIndex(): Promise<WorkerIndex> {
  if (cached && cached.path === indexPath()) return cached.value;
  let value: WorkerIndex = EMPTY;
  try {
    const raw = await fs.readFile(indexPath(), "utf-8");
    const parsed = JSON.parse(raw) as WorkerIndex;
    if (parsed && Array.isArray(parsed.workers)) value = parsed;
  } catch {
    // missing/corrupt index -> start empty
  }
  cached = { path: indexPath(), value };
  return value;
}

async function writeIndex(value: WorkerIndex): Promise<void> {
  cached = { path: indexPath(), value };
  await atomicWriteText(indexPath(), JSON.stringify(value, null, 2), { mode: 0o600 });
}

function prune(value: WorkerIndex): WorkerIndex {
  if (value.workers.length <= MAX_WORKERS) return value;
  const terminal = new Set<WorkerStatus>(["completed", "failed", "cancelled", "interrupted"]);
  const sorted = [...value.workers].sort((a, b) => b.started_at.localeCompare(a.started_at));
  const active = sorted.filter((w) => !terminal.has(w.status));
  const finished = sorted.filter((w) => terminal.has(w.status));
  return { version: 1, workers: [...active, ...finished.slice(0, MAX_WORKERS - active.length)] };
}

async function mutate(fn: (value: WorkerIndex) => WorkerIndex): Promise<WorkerIndex> {
  const operation = mutationQueue.catch(() => undefined).then(async () => {
    const next = prune(fn(await readIndex()));
    await writeIndex(next);
    return next;
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

const TERMINAL = new Set<WorkerStatus>(["completed", "failed", "cancelled", "interrupted"]);

export function isTerminalWorkerStatus(status: WorkerStatus): boolean {
  return TERMINAL.has(status);
}

export async function registerWorker(input: {
  id?: string;
  source: WorkerSource;
  kind: string;
  objective?: string;
  workspace?: string;
  parent_task_id?: string;
  pid?: number;
  provider?: string;
  model?: string;
  cost_limit_cents?: number;
  timeout_ms?: number;
  lifecycle_owner?: string;
}): Promise<WorkerRecord> {
  const now = new Date().toISOString();
  const record: WorkerRecord = {
    id: input.id ?? randomUUID().slice(0, 12),
    source: input.source,
    kind: input.kind,
    status: "running",
    objective: input.objective?.slice(0, 240) ?? undefined,
    workspace: input.workspace,
    parent_task_id: input.parent_task_id,
    started_at: now,
    updated_at: now,
    pid: input.pid,
    provider: input.provider,
    model: input.model,
    cost_limit_cents: input.cost_limit_cents,
    timeout_ms: input.timeout_ms,
    lifecycle_owner: input.lifecycle_owner ?? "local-mcp",
  };
  await mutate((value) => ({ version: 1, workers: [record, ...value.workers.filter((w) => w.id !== record.id)] }));
  return record;
}

export async function updateWorkerStatus(
  id: string,
  status: WorkerStatus,
  meta: { reason?: string; finished_at?: string; finished?: boolean; cost_actual_cents?: number } = {}
): Promise<WorkerRecord | undefined> {
  let updated: WorkerRecord | undefined;
  await mutate((value) => {
    const index = value.workers.findIndex((w) => w.id === id);
    if (index < 0) return value;
    const before = value.workers[index];
    // never let a late termination crash-clobber an explicit cancelled state
    if (status === "failed" && (before.status === "cancelled" || before.status === "interrupted")) {
      before.updated_at = new Date().toISOString();
      return value;
    }
    const next: WorkerRecord = {
      ...before,
      status,
      updated_at: new Date().toISOString(),
      ...(meta.finished_at || meta.finished || TERMINAL.has(status)
        ? { finished_at: meta.finished_at ?? new Date().toISOString() }
        : {}),
      ...(meta.reason ? { reason: meta.reason.slice(0, 300) } : {}),
      ...(meta.cost_actual_cents != null ? { cost_actual_cents: meta.cost_actual_cents } : {}),
    };
    value.workers[index] = next;
    updated = next;
    return value;
  });
  return updated;
}

export async function listWorkers(status?: WorkerStatus): Promise<WorkerRecord[]> {
  const value = await readIndex();
  const workers = status ? value.workers.filter((w) => w.status === status) : value.workers;
  return [...workers].sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export async function getWorker(id: string): Promise<WorkerRecord | undefined> {
  const value = await readIndex();
  return value.workers.find((w) => w.id === id);
}

/** Workers that are still authorised and not terminal — what `lcp off` must account for. */
export async function ownedWorkers(): Promise<WorkerRecord[]> {
  const value = await readIndex();
  return value.workers
    .filter((w) => !TERMINAL.has(w.status) && w.lifecycle_owner === "local-mcp")
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export async function removeWorker(id: string): Promise<boolean> {
  let removed = false;
  await mutate((value) => {
    const next = value.workers.filter((w) => w.id !== id);
    removed = next.length !== value.workers.length;
    return { version: 1, workers: next };
  });
  return removed;
}

export async function clearWorkers(): Promise<number> {
  let count = 0;
  await mutate((value) => {
    count = value.workers.length;
    return { version: 1, workers: [] };
  });
  return count;
}

/** Reconcile registry after restart: mark in-flight local workers interrupted. */
export async function reconcileOwnedWorkers(): Promise<number> {
  let count = 0;
  for (const worker of await ownedWorkers()) {
    if (worker.status === "running" || worker.status === "queued") {
      await updateWorkerStatus(worker.id, "interrupted", {
        reason: "Parent Local ChatGPT Plus service restarted; worker supervision lost.",
      });
      count++;
    }
  }
  return count;
}

// Ensure the directory exists early (best-effort).
void fs.mkdir(storeRoot(), { recursive: true }).catch(() => undefined);