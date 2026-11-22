import type { ChildProcess } from "node:child_process";

export function osProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Terminate a detached POSIX process group or fall back to its direct child. */
export async function terminateChildProcessTree(child: ChildProcess, force = true): Promise<void> {
  const signal = force ? "SIGKILL" : "SIGTERM";
  if (!child.pid || child.pid <= 0) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}