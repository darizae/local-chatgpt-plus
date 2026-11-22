import fs from "fs/promises";
import path from "path";
import { sameResolvedPath } from "./path-identity.js";
import { atomicWriteText } from "./atomic-file.js";

export type OperationStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface OperationRecord {
  id: string;
  label?: string;
  task_id?: string;
  session_id?: string;
  project_root?: string | null;
  command: string;
  cwd: string;
  pid?: number;
  status: Exclude<OperationStatus, "interrupted">;
  started_at: string;
  finished_at?: string;
  exit_code?: number | null;
  signal?: NodeJS.Signals | null;
  spawn_error?: string;
  stdout_tail?: string;
  stderr_tail?: string;
  last_progress_at?: string;
}

interface OperationIndex {
  version: 1;
  operations: OperationRecord[];
}

const MAX_OPERATIONS = 250;
// Durable operation state is metadata, not a second log/credential store.
// Process output is still available to the authorized live caller via the
// bounded process_output tool; it must not survive as raw persistent content.
const REDACTED_COMMAND = "[command withheld]";
const REDACTED_OUTPUT = "[output withheld from durable state]";
const REDACTED_ERROR = "[error details withheld]";

function safeRecord(record: OperationRecord): OperationRecord {
  return {
    ...record,
    command: REDACTED_COMMAND,
    ...(record.stdout_tail ? { stdout_tail: REDACTED_OUTPUT } : {}),
    ...(record.stderr_tail ? { stderr_tail: REDACTED_OUTPUT } : {}),
    ...(record.spawn_error ? { spawn_error: REDACTED_ERROR } : {}),
  };
}
let mutationQueue: Promise<void> = Promise.resolve();
let cachedIndex: { path: string; value: OperationIndex } | null = null;

function storeRoot(): string {
  return process.env.MCP_OPERATION_STATE_DIR || path.resolve(process.cwd(), ".mcp-state", "operations");
}

function indexPath(): string {
  return path.join(storeRoot(), "index.json");
}

async function readIndex(): Promise<OperationIndex> {
  const currentPath = indexPath();
  if (cachedIndex?.path === currentPath) return structuredClone(cachedIndex.value);
  try {
    const parsed = JSON.parse(await fs.readFile(currentPath, "utf-8")) as OperationIndex;
    if (parsed.version === 1 && Array.isArray(parsed.operations)) {
      const safe = { version: 1 as const, operations: parsed.operations.map(safeRecord) };
      // Migrate legacy raw history in-place using atomic replace on first read.
      if (JSON.stringify(safe) !== JSON.stringify(parsed)) {
        await atomicWriteText(currentPath, JSON.stringify(safe, null, 2));
      }
      cachedIndex = { path: currentPath, value: structuredClone(safe) };
      return safe;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const empty: OperationIndex = { version: 1, operations: [] };
  cachedIndex = { path: currentPath, value: structuredClone(empty) };
  return empty;
}

async function writeIndex(index: OperationIndex): Promise<void> {
  const currentPath = indexPath();
  const safe = { version: 1 as const, operations: index.operations.map(safeRecord) };
  await atomicWriteText(currentPath, JSON.stringify(safe, null, 2));
  cachedIndex = { path: currentPath, value: structuredClone(safe) };
}

async function mutate<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const previous = mutationQueue;
  mutationQueue = previous.then(() => gate, () => gate);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

function pruneOperations(records: OperationRecord[]): OperationRecord[] {
  if (records.length <= MAX_OPERATIONS) return records;
  const running = records.filter((record) => record.status === "running");
  const terminal = records
    .filter((record) => record.status !== "running")
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  // Never evict a live operation merely because historical retention is full.
  // If there are more than MAX_OPERATIONS simultaneously running operations,
  // temporarily exceed the retention target rather than losing finish state.
  const terminalBudget = Math.max(0, MAX_OPERATIONS - running.length);
  return [...running, ...terminal.slice(0, terminalBudget)]
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}

export async function recordOperationStart(record: OperationRecord): Promise<void> {
  await mutate(async () => {
    const index = await readIndex();
    index.operations = index.operations.filter((item) => item.id !== record.id);
    index.operations.push(safeRecord(record));
    index.operations.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    index.operations = pruneOperations(index.operations);
    await writeIndex(index);
  });
}

export async function recordOperationFinish(
  id: string,
  updates: Partial<Pick<OperationRecord, "status" | "finished_at" | "exit_code" | "signal" | "spawn_error" | "stdout_tail" | "stderr_tail" | "last_progress_at">>
): Promise<void> {
  await mutate(async () => {
    const index = await readIndex();
    const record = index.operations.find((item) => item.id === id);
    if (!record) return;
    Object.assign(record, {
      ...updates,
      ...(updates.stdout_tail ? { stdout_tail: REDACTED_OUTPUT } : {}),
      ...(updates.stderr_tail ? { stderr_tail: REDACTED_OUTPUT } : {}),
      ...(updates.spawn_error ? { spawn_error: REDACTED_ERROR } : {}),
    });
    await writeIndex(index);
  });
}

export async function listOperationHistory(options: {
  limit?: number;
  task_id?: string;
  project_root?: string | null;
  active_ids?: Set<string>;
} = {}): Promise<Array<OperationRecord & { effective_status: OperationStatus }>> {
  const index = await readIndex();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return index.operations
    .filter((record) => !options.task_id || record.task_id === options.task_id)
    .filter((record) => {
      if (options.project_root === undefined) return true;
      if (options.project_root === null) return !record.project_root;
      return Boolean(record.project_root && sameResolvedPath(record.project_root, options.project_root));
    })
    .slice(0, limit)
    .map((record) => ({
      ...record,
      effective_status: record.status === "running" && !options.active_ids?.has(record.id) ? "interrupted" : record.status,
    }));
}

export async function getOperationRecord(id: string, activeIds?: Set<string>) {
  const index = await readIndex();
  const record = index.operations.find((item) => item.id === id);
  if (!record) return null;
  return {
    ...record,
    effective_status: record.status === "running" && !activeIds?.has(record.id) ? "interrupted" as const : record.status,
  };
}