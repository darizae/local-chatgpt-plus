import { getManagedProcessSnapshot } from "../tools/shell.js";
import { durableJobsEnabled, durableRpc, type DurableJob } from "./durable-jobs.js";
import { listOperationHistory } from "./operation-store.js";
import { isAgentRunnerCommand, resolveWorkerTaskId } from "./task-workspace.js";
import { listWorkers } from "./worker-registry.js";
import { listSubagents } from "./subagent-manager.js";
import { inspectTaskGit } from "./task-git-evidence.js";
import { getAgentTaskProgress, type AgentTaskRecord } from "./agent-task-store.js";
import { summarizeTaskExecution } from "./task-execution.js";

/** Read-only snapshot. Do not mutate historical process/task affiliation. */
export async function taskExecutionContext() {
  const current = getManagedProcessSnapshot();
  const processes = await Promise.all(current.map(async (proc) => ({
    ...proc,
    task_id: proc.task_id || (proc.running && isAgentRunnerCommand(proc.command)
      ? await resolveWorkerTaskId(proc.cwd).catch(() => undefined)
      : undefined),
  })));
  const activeIds = new Set(current.filter((proc) => proc.running).map((proc) => proc.id));
  const [workersResult, operationsResult, durableResult] = await Promise.allSettled([
    listWorkers(),
    listOperationHistory({ limit: 200, active_ids: activeIds }),
    durableJobsEnabled() ? durableRpc<{jobs:DurableJob[]}>({action:"list"}) : Promise.resolve({jobs:[] as DurableJob[]}),
  ]);
  const source_errors = [
    ...(workersResult.status === "rejected" ? ["Worker-registry diagnostics unavailable"] : []),
    ...(operationsResult.status === "rejected" ? ["Process-history diagnostics unavailable"] : []),
    ...(durableResult.status === "rejected" ? ["Durable job supervisor diagnostics unavailable"] : []),
  ];
  const liveSubagents = new Set(listSubagents().filter((agent) => agent.running).map((agent) => agent.id));
  const workers = workersResult.status === "fulfilled" ? workersResult.value.map((worker) =>
    worker.source === "omp-subagent" && worker.status === "running" && !liveSubagents.has(worker.id)
      ? { ...worker, status: "interrupted" as const } : worker) : [];
  const operations = operationsResult.status === "fulfilled" ? operationsResult.value : [];
  const durable=durableResult.status==="fulfilled"?durableResult.value.jobs:[];
  return { processes:[...processes,...durable], workers,
    operations:[...operations,...durable.map(j=>({...j,effective_status:j.status}))], source_errors };
}

export async function taskWithExecution(task: AgentTaskRecord, context: Awaited<ReturnType<typeof taskExecutionContext>>) {
  const git = task.status === "active" || task.status === "blocked"
    ? await inspectTaskGit(task.workspace) : null;
  const execution = summarizeTaskExecution({ task, ...context, git });
  return {
    ...task,
    progress: getAgentTaskProgress(task),
    execution: context.source_errors.length
      ? { ...execution, warnings: [...execution.warnings, ...context.source_errors] }
      : execution,
  };
}
