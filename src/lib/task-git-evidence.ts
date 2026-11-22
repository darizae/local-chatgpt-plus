/** Read-only, bounded repository signals. A commit is NOT verification. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export interface TaskGitEvidence {
  head: string;
  committed_at: string;
  dirty: boolean;
}

export async function inspectTaskGit(workspace: string): Promise<TaskGitEvidence | null> {
  try {
    const [headResult, dirtyResult] = await Promise.all([
      runFile("git", ["log", "-1", "--format=%H%x09%cI"], {
        cwd: workspace, timeout: 2_000, maxBuffer: 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      }),
      runFile("git", ["status", "--porcelain", "--untracked-files=normal"], {
        cwd: workspace, timeout: 2_000, maxBuffer: 1_000_000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      }),
    ]);
    const [head, committed_at] = headResult.stdout.trim().split("\t");
    if (!/^[0-9a-f]{40,64}$/i.test(head || "") || !Number.isFinite(Date.parse(committed_at))) return null;
    return { head, committed_at, dirty: dirtyResult.stdout.trim().length > 0 };
  } catch {
    return null;
  }
}
