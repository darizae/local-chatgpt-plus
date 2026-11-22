/** Derived, read-only task execution status. A saved plan is never a worker. */
import type { AgentTaskRecord } from "./agent-task-store.js";
import type { WorkerRecord } from "./worker-registry.js";
import type { TaskGitEvidence } from "./task-git-evidence.js";

export interface ExecutionProcess {
  id: string;
  task_id?: string;
  running: boolean;
  last_activity_at?: string;
  started_at?: string;
}

export interface ExecutionOperation {
  id: string;
  task_id?: string;
  effective_status: string;
  started_at: string;
  finished_at?: string;
  exit_code?: number | null;
}

export type TaskExecutionState = "running" | "waiting" | "stalled" | "blocked" | "completed" | "cancelled";

export function summarizeTaskExecution(input: {
  task: AgentTaskRecord;
  processes: readonly ExecutionProcess[];
  workers: readonly WorkerRecord[];
  operations: readonly ExecutionOperation[];
  git?: TaskGitEvidence | null;
  now?: number;
  staleMinutes?: number;
}) {
  const { task, git } = input;
  const now = input.now ?? Date.now();
  const staleMs = Math.max(1, input.staleMinutes ?? 20) * 60_000;
  const linkedProcesses = input.processes.filter((p) => p.task_id === task.id);
  const linkedWorkers = input.workers.filter((w) => w.parent_task_id === task.id);
  const activeIds = new Set<string>([
    ...linkedProcesses.filter((p) => p.running).map((p) => p.id),
    ...linkedWorkers.filter((w) => w.status === "running" || w.status === "queued")
      .map((w) => w.id),
  ]);
  const waitingForUser = linkedWorkers.some((w) => w.status === "waiting_for_user");
  const mostRecentProcessActivity = linkedProcesses.filter((p) => p.running)
    .map((p) => Date.parse(p.last_activity_at || p.started_at || ""));
  const newestActivity = Math.max(0, ...mostRecentProcessActivity.filter(Number.isFinite));
  const latestExit = [
    ...linkedWorkers.filter((w) => ["failed", "interrupted", "cancelled", "completed"].includes(w.status))
      .map((w) => ({ id: w.id, status: w.status, at: w.finished_at || w.updated_at, reason: w.reason })),
    ...(task.worker_events ?? []).map((event) => ({
      id: event.worker_id, status: event.outcome, at: event.at, reason: event.reason,
    })),
    ...input.operations.filter((o) => o.task_id === task.id && o.effective_status !== "running")
      .map((o) => ({
        id: o.id, status: o.effective_status, at: o.finished_at || o.started_at,
        reason: o.effective_status === "failed" ? `Process exited with code ${o.exit_code ?? "unknown"}` : undefined,
      })),
  ].sort((a, b) => Date.parse(b.at || "") - Date.parse(a.at || ""))[0] ?? null;
  const recentFailure = latestExit && ["failed", "interrupted", "stopped"].includes(latestExit.status)
    ? latestExit : null;
  const taskAgeMs = Math.max(0, now - (Date.parse(task.updated_at) || now));
  const noProgressMs = newestActivity ? Math.max(0, now - newestActivity) : null;

  let state: TaskExecutionState;
  let reason: string;
  if (["completed", "archived"].includes(task.status)) {
    state = "completed";
    reason = "The saved task is finished; a new worker would require explicit reactivation.";
  } else if (task.status === "cancelled" || task.status === "abandoned") {
    state = "cancelled";
    reason = "The saved task has been cancelled or abandoned.";
  } else if (activeIds.size) {
    state = "running";
    reason = noProgressMs != null && noProgressMs > staleMs
      ? "A linked worker is alive but has been silent; check its progress before assuming a hang."
      : "At least one linked worker is running.";
  } else if (task.status === "blocked") {
    state = "blocked";
    reason = "The saved task is explicitly blocked; inspect its outstanding step or note.";
  } else if (waitingForUser) {
    state = "waiting";
    reason = "A linked worker reports that user input is needed.";
  } else if (recentFailure) {
    state = "stalled";
    reason = `Last linked worker ended ${recentFailure.status}; review its output before resuming.`;
  } else if (taskAgeMs >= staleMs) {
    state = "stalled";
    reason = "The task is old and has no linked running worker. It cannot resume autonomously.";
  } else {
    state = "waiting";
    reason = "The task has no linked running worker; a coordinating agent must continue it.";
  }

  const completedSteps = task.steps.filter((s) => s.status === "completed" || s.status === "skipped").length;
  const warnings: string[] = [];
  const latestVerification = task.verification_checkpoints?.at(-1) ?? null;
  const lastPassed = [...(task.verification_checkpoints ?? [])].reverse().find((c) => c.passed) ?? null;
  const gitIsNewer = git && Date.parse(git.committed_at) > Date.parse(task.updated_at) + 60_000;
  if (gitIsNewer && completedSteps < task.steps.length) {
    warnings.push("Git HEAD was committed after the last task-plan update; progress may be out of sync. A commit does not prove tests passed.");
  }
  if (lastPassed && git && (!lastPassed.workspace || lastPassed.workspace === task.workspace) &&
      (git.head !== lastPassed.git_head || git.dirty || lastPassed.dirty)) {
    warnings.push("The repository differs from its last successful verification checkpoint; re-run checks before marking steps completed.");
  }
  if (activeIds.size && noProgressMs != null && noProgressMs > staleMs) {
    warnings.push("Linked process has had no captured output for the stale threshold; this is a signal, not proof of a hang.");
  }

  return {
    status_scope: "persistent_plan" as const,
    state, reason,
    running_worker_count: activeIds.size,
    running_worker_ids: [...activeIds].slice(0, 10),
    last_worker_exit: latestExit ? { ...latestExit, reason: latestExit.reason?.slice(0, 300) } : null,
    last_verified_checkpoint: latestVerification,
    git: git ? { head: git.head, committed_at: git.committed_at, dirty: git.dirty } : null,
    progress_may_be_out_of_sync: warnings.some((w) => w.includes("out of sync")),
    warnings,
    recovery: activeIds.size ? "inspect_running_workers" : state === "stalled"
      ? (recentFailure ? "inspect_failed_worker_then_resume_from_checkpoint" : "inspect_git_and_resume_plan")
      : state === "blocked" ? "resolve_blocked_step" : state === "waiting" ? "resume_or_wait_for_user" : "none",
    note: "Observational status only. Never restarts, retries, completes, or cleans work automatically.",
  };
}
