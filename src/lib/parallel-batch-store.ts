import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteText } from "./atomic-file.js";
import type { ToolFailureMetadata } from "./error-model.js";

export interface ParallelCommandSpec {
  command: string;
  working_directory?: string;
  timeout_seconds?: number;
  success_exit_codes?: number[];
}

export interface ParallelCommandResult {
  index: number;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  duration_ms: number;
  error?: string;
  failure?: ToolFailureMetadata;
  // Only preflight-rejected commands are provably not delivered. A timeout,
  // crashed worker or nonzero exit may have already changed external state.
  delivery?: "not_delivered" | "possibly_delivered";
  output_handle?: string | null;
  output_chars?: number;
  truncated?: boolean;
}

export interface ParallelBatchRecord {
  version: 1;
  id: string;
  created_at: string;
  updated_at: string;
  concurrency: number;
  commands: ParallelCommandSpec[];
  results: Array<ParallelCommandResult | null>;
  attempts: number;
}

/** Never replay a batch command with an uncertain or completed side effect. */
export function safeBatchRetryIndices(record: ParallelBatchRecord): number[] {
  return record.results.flatMap((item, index) =>
    item?.delivery === "not_delivered" && item.error ? [index] : []
  );
}

const batchLocks = new Map<string, Promise<void>>();

function root(): string {
  return path.resolve(process.env.MCP_PARALLEL_BATCH_STATE_DIR?.trim() || path.join(process.cwd(), ".mcp-state", "parallel-batches"));
}

function assertId(id: string): string {
  if (!/^batch_[a-zA-Z0-9_.-]+$/.test(id)) throw new Error("Invalid parallel batch id");
  return id;
}

export function newParallelBatchId(): string {
  return `batch_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export async function saveParallelBatch(record: ParallelBatchRecord): Promise<void> {
  const id = assertId(record.id);
  const previous = batchLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.catch(() => undefined).then(() => gate);
  batchLocks.set(id, current);
  await previous.catch(() => undefined);
  try {
    record.updated_at = new Date().toISOString();
    const target = path.join(root(), `${id}.json`);
    await atomicWriteText(target, JSON.stringify(record, null, 2));
  } finally {
    release();
    if (batchLocks.get(id) === current) batchLocks.delete(id);
  }
}

export async function loadParallelBatch(id: string): Promise<ParallelBatchRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root(), `${assertId(id)}.json`), "utf-8")) as ParallelBatchRecord;
    if (parsed.version !== 1 || parsed.id !== id || !Array.isArray(parsed.commands) || !Array.isArray(parsed.results)) {
      throw new Error(`Malformed parallel batch record: ${id}`);
    }
    parsed.results = Array.from({ length: parsed.commands.length }, (_, index) => parsed.results[index] ?? null);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}