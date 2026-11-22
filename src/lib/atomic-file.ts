import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function tempPath(target: string): string {
  return `${target}.${process.pid}.${randomUUID().replace(/-/g, "").slice(0, 10)}.tmp`;
}

async function existingMode(target: string): Promise<number | undefined> {
  try {
    return (await fs.stat(target)).mode & 0o777;
  } catch {
    return undefined;
  }
}

function existingModeSync(target: string): number | undefined {
  try {
    return fsSync.statSync(target).mode & 0o777;
  } catch {
    return undefined;
  }
}

// Flush the temp file before rename so the new bytes are durable, then fsync
// the parent directory after rename so the rename itself survives a crash.
// Directory fsync is best-effort: some filesystems reject it (EINVAL), and a
// rename that reaches the page cache is still the correct atomic fallback.
async function fsyncFile(target: string): Promise<void> {
  const fh = await fs.open(target, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function fsyncDir(target: string): Promise<void> {
  const fh = await fs.open(target, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export async function atomicWriteText(
  targetPath: string,
  content: string,
  options?: { mode?: number }
): Promise<void> {
  const target = path.resolve(targetPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = tempPath(target);
  const mode = options?.mode ?? await existingMode(target);
  try {
    await fs.writeFile(temp, content, {
      encoding: "utf-8",
      ...(mode === undefined ? {} : { mode }),
    });
    await fsyncFile(temp);
    await fs.rename(temp, target);
    await fsyncDir(path.dirname(target)).catch(() => undefined);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export function atomicWriteTextSync(
  targetPath: string,
  content: string,
  options?: { mode?: number }
): void {
  const target = path.resolve(targetPath);
  fsSync.mkdirSync(path.dirname(target), { recursive: true });
  const temp = tempPath(target);
  const mode = options?.mode ?? existingModeSync(target);
  try {
    fsSync.writeFileSync(temp, content, {
      encoding: "utf-8",
      ...(mode === undefined ? {} : { mode }),
    });
    const fh = fsSync.openSync(temp, "r");
    try { fsSync.fsyncSync(fh); } finally { fsSync.closeSync(fh); }
    fsSync.renameSync(temp, target);
    try {
      const dirFh = fsSync.openSync(path.dirname(target), "r");
      try { fsSync.fsyncSync(dirFh); } finally { fsSync.closeSync(dirFh); }
    } catch {}
  } finally {
    try { fsSync.rmSync(temp, { force: true }); } catch {}
  }
}