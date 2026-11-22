/**
 * Strict task/worker association across a project and its Git worktrees.
 * Never infer affiliation from directory names, remote URLs, or prompt text.
 * An ambiguous match stays unlinked until a task_id is specified explicitly.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAgentTask, listAgentTasks, type AgentTaskRecord } from "./agent-task-store.js";
import { isPathInside, sameResolvedPath } from "./path-identity.js";

const runFile = promisify(execFile);

export async function gitCommonDirectory(workspace: string): Promise<string | null> {
  try {
    const { stdout } = await runFile("git", ["rev-parse", "--git-common-dir"], {
      cwd: workspace, timeout: 2_000, maxBuffer: 4096,
    });
    const common = stdout.trim().split(/\r?\n/)[0];
    if (!common) return null;
    const absolute = path.resolve(workspace, common);
    return await fs.realpath(absolute);
  } catch {
    return null;
  }
}

async function canonicalWorkspace(workspace: string): Promise<string> {
  return await fs.realpath(workspace).catch(() => path.resolve(workspace));
}

export async function isWorkspaceForTask(taskWorkspace: string, workerWorkspace: string): Promise<boolean> {
  // On macOS /var and /tmp may be symlinks into /private/var and /private/tmp.
  // The shell tool already canonicalizes cwd; task records may use the alias.
  const [taskPath, workerPath] = await Promise.all([
    canonicalWorkspace(taskWorkspace), canonicalWorkspace(workerWorkspace),
  ]);
  if (isPathInside(taskPath, workerPath)) return true;
  const [taskGit, workerGit] = await Promise.all([
    gitCommonDirectory(taskWorkspace), gitCommonDirectory(workerWorkspace),
  ]);
  return Boolean(taskGit && workerGit && sameResolvedPath(taskGit, workerGit));
}

export async function resolveWorkerTaskId(workspace: string, explicitId?: string): Promise<string | undefined> {
  if (explicitId) {
    const task = await getAgentTask(explicitId);
    if (!task) throw new Error(`Unknown agent task id: ${explicitId}`);
    if (task.status !== "active" && task.status !== "blocked") {
      throw new Error(`Agent task ${explicitId} is ${task.status}; reactivate it before starting workers`);
    }
    if (!(await isWorkspaceForTask(task.workspace, workspace))) {
      throw new Error(`Worker workspace is outside agent task ${explicitId} repository or workspace`);
    }
    return explicitId;
  }

  const resumable = (await listAgentTasks()).filter((task: AgentTaskRecord) =>
    task.status === "active" || task.status === "blocked");
  // Prefer exactly one task rooted at this workspace over tasks for other
  // worktrees of the same repository. Never guess when multiple match.
  const workerPath = await canonicalWorkspace(workspace);
  const exact = [];
  for (const task of resumable) {
    if (sameResolvedPath(await canonicalWorkspace(task.workspace), workerPath)) exact.push(task);
  }
  if (exact.length) return exact.length === 1 ? exact[0].id : undefined;
  const workerGit = await gitCommonDirectory(workspace);
  const matching: string[] = [];
  for (const task of resumable) {
    const taskPath = await canonicalWorkspace(task.workspace);
    if (isPathInside(taskPath, workerPath) ||
        (workerGit && sameResolvedPath(await gitCommonDirectory(task.workspace) || "", workerGit))) {
      matching.push(task.id);
    }
    if (matching.length > 1) return undefined;
  }
  return matching.length === 1 ? matching[0] : undefined;
}

/** Only infer association for recognizable agent runner commands. */
export function isAgentRunnerCommand(command: string): boolean {
  const first = command.trim().match(/^(?:"[^"]+"|'[^']+'|\S+)/)?.[0];
  if (!first) return false;
  const base = path.basename(first.replace(/^['"]|['"]$/g, ""));
  return /^(?:omp|codex|claude|gemini|pi)(?:\.exe)?$/i.test(base);
}
