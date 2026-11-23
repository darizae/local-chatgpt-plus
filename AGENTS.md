# Local ChatGPT Plus — Agent Onboarding

Local MCP server for coding-agent workflows in the regular ChatGPT app: read and edit files, run commands, manage Git, inspect project context, keep task state, and proxy upstream MCP servers. It is designed for ChatGPT Developer Mode/chat connectors, not Codex or ChatGPT Work.

## First connection

The default project's memory and Git state are already injected into MCP instructions. Call these only when useful:

1. **`agent_status`** — inspect permissions, machine roots, current tool profile, rewind configuration, and upstream MCP status.
2. **`project_context(path)`** — load `AGENTS.md`, `CLAUDE.md`, README, and related project context when working in a project other than the configured `WORKSPACE_PATH`.

## Access model

- A fresh checkout defaults to the `workspace` permission profile; `open` is an explicit opt-in for full local paths, commands, and configured runtimes (subject to OS ACLs). `read_only` and `custom` profiles can tighten access further.
- Absolute paths are supported, for example `/Users/you/Projects/...` and `/Volumes/ExternalDrive/projects/...`.
- `WORKSPACE_PATH` sets the default cwd for relative paths, shell commands, and Git. By itself it is not a sandbox boundary; restrictive Local ChatGPT Plus permission profiles can enforce configured roots at the application layer.
- ChatGPT may create a fresh MCP transport for each tool call. Treat transport/session IDs as diagnostics, not chat/work ownership. Use explicit `path`, `workspace`, and especially `working_directory` for project work; Local ChatGPT Plus derives mutation scope per call.
- Read-only upstream MCP tools can remain available under restrictive profiles; mutating or annotation-unknown upstream calls are treated as unsafe runtimes and require explicit permission.
- `CHATGPT_AUTO_APPROVE=true` marks routine local operations to reduce unnecessary confirmation prompts.

## ChatGPT connector behavior

Before starting work after a server update or restart:

1. Open **Settings → Apps / Connectors** and select the Local ChatGPT Plus connector.
2. Choose the connector permission level you want.
3. Refresh the connector after server/tool-schema changes.
4. Start a new chat and enable/tag the connector before sending the task.

Avoid relying on the popup **Always allow** action if it causes the MCP session to reset. If the tunnel reports `stream canceled by remote`, keep the server and tunnel running, refresh the connector, and start a new MCP chat.

On macOS, provision a compatible tunnel client and credentials separately. Set `LOCAL_CODER_MANAGE_TUNNEL` to opt into the built-in supervisor, or start your own HTTPS tunnel in a second terminal.

## Tool profiles

`CHATGPT_TOOL_PROFILE` controls which native tools are advertised to the client:

| Profile | Purpose |
|---|---|
| `slim` *(default)* | Core coding tools for the ChatGPT app with a smaller `tools/list` payload. |
| `full` | Every native Local ChatGPT Plus tool. Useful for other MCP clients or less common operations. |

The complete native catalog is maintained in `src/lib/tool-profile.ts` and is checked against literal `server.registerTool()` declarations by `scripts/test-tool-profile.mjs`. Do not maintain separate hard-coded tool counts in documentation.

The Admin UI can force-enable a native tool outside `slim` or disable any native tool through `profiles/tool-overrides.json`. Unknown/stale override names are filtered automatically.

The default `slim` profile includes the high-value read/edit/search tools, bounded and parallel shell execution, background-process lifecycle tools, PTY/image inspection, Git status/diff/worktree/commit, project/task/transaction/coding-loop/context-capsule tools, rewind, skills/rules, subagent execution, and `mcp_servers`. Overlapping or lower-level helpers such as `multi_edit`, raw `lsp`, `delegate_status`, `git_add`, `git_restore`, destructive/remote Git helpers, raw binary writes, shell reset/clear-process helpers, `node_repl`, `ponytail_turn`, and low-level `mcp_tools` / `mcp_call` remain opt-in/full-profile unless explicitly overridden. Treat `src/lib/tool-profile.ts` as authoritative.

## Claude Code ↔ Local ChatGPT Plus mapping

| Claude Code concept | Local ChatGPT Plus | Notes |
|---|---|---|
| `Read` | `read_text_file` | Supports `offset` + `limit` with line numbers. |
| `Write` | `write_file` | Creates or overwrites text files. |
| `Edit` | `edit_file` | Exact text replacement with optional `replace_all`. |
| `MultiEdit` | `multi_edit` | Atomic multiple replacements in one file. |
| `Glob` | `glob` | File-name discovery. |
| `Grep` | `grep` | `content`, `files_with_matches`, and `count` modes. |
| `LS` | `list_directory` | Optional ignore globs. |
| `Bash` | `run_command` | Short/finite commands; pass `working_directory`. Cwd is transport-local and is not persisted for ChatGPT by default. |
| Parallel shell | `run_commands_parallel` | Independent commands run concurrently in isolated processes. Batch state is durable so retry/recovery should rerun only failed or incomplete members. |
| Background shell | `start_process` + process tools | Use `process_status`, `process_output`, `process_input`, and `stop_process`. Prefer event/wait conditions for exit/text instead of repeated `sleep` polling. `process_input` is piped stdin, not a full PTY. |
| Interactive terminal | `pty` | Real PTY for TUIs, debuggers, installers, and terminal-native CLIs. |
| LSP | `lsp` | Hover, definitions, references, symbols, and diagnostics. TypeScript/JS and Python are bundled. |
| Local image inspection | `view_image` | Returns a local image path as MCP image content so the host can inspect it visually. |
| Rewind | `rewind` | `list` → `preview` → `restore` for automatic file-edit checkpoints. |
| Project rules | `project_context`, `load_path_rules` | Loads project and path-scoped instructions. |
| Skills | `list_skills`, `load_skill` | Load matching project/plugin skills before use. |
| Computer use | `computer_observe`, `computer_act` | Opt-in desktop/browser MCP: recent window-scoped refs, safe-only retry and screenshot fallback. Sensitive actions require a macOS operator dialog by default (`MCP_COMPUTER_APPROVAL_MODE`: sensitive/all/off), which is defense in depth, not an OS sandbox. Electron CDP is loopback-only. |
| Persistent task state | `agent_task` | Stores objective, plan, notes, workspace, and status across MCP sessions. `action=review` inspects old tasks in one explicitly named workspace without modifying state. Project-bound sessions cannot mutate another project's tasks. It is **not** a subagent. |
| Resumable chat working state | `context_capsule` | Stores a bounded semantic handoff plus live task/loop/transaction/Git state when ChatGPT conversation context may be lost. |
| External subagent | `subagent` | Runs a separately configured model-capable process, optionally in an isolated Git worktree. It cannot reuse the parent ChatGPT subscription. |
| Delegate discovery | `delegate_status` | Detects supported Claude/Codex/Grok/OpenCode CLIs without launching them. |
| Isolated Git work | `git_worktree` | Useful for parallel or experimental branches without switching the main checkout. |
| Upstream MCP | `<server>__<tool>` | Enabled upstream tools may be exposed directly. Regardless of remote read-only annotations, direct proxies require local write and unsafe-runtime permission. |
| Upstream diagnostics | `mcp_servers`, `mcp_tools`, `mcp_call` | Low-level bridge/fallback; `mcp_call` enforces the upstream exposure allowlist and write/unsafe-runtime permissions. |

Real delegated subagents are available through the external-runner `subagent` tool when explicitly configured. Web browsing, general uploaded-file understanding, data analysis, and browser/site tooling can still be supplied by the ChatGPT host instead of being duplicated in Local ChatGPT Plus.

## Recommended coding workflow

| Task | Preferred tool |
|---|---|
| Find files | `glob` |
| Search source | `grep` |
| Read a file | `read_text_file` |
| List a directory | `list_directory` |
| Patch code | `apply_patch` *(preferred)* |
| Apply several exact edits | `multi_edit` |
| Create a text file | `write_file` |
| Short command/build/test | `run_command` |
| Independent commands in parallel | `run_commands_parallel`; recover/retry only failed or incomplete members when a batch id is returned |
| Long-running build/server | `start_process` → `process_status` / `process_output` with wait condition → optional `process_input` → `stop_process` |
| Interactive terminal/TUI/debugger | `pty` |
| Definition/reference/diagnostics | `repo_intel` in slim; raw `lsp` in full/override profile |
| Inspect a local screenshot/image | `view_image` |
| Inspect Git | `git_status`, `git_diff` |
| Isolated branch work | `git_worktree` |
| Commit | `git_commit` (stages all changes by default; use `stage_all=false` for already-staged changes) |
| Lower-level stage/restore | `git_add`, `git_restore` in full/override profile |
| Persist a long task | `agent_task` |
| Preserve/resume long-chat working context | `context_capsule` |
| Delegate to configured external model runner | `subagent` |
| Detect compatible local agent CLIs | `delegate_status` |
| Undo Local ChatGPT Plus file edits | `rewind` |

For non-trivial changes: explore first, read every file you will edit, apply the smallest practical patch, then run relevant build/tests. Preserve unrelated user changes in a dirty working tree.

When a shell command may edit files, prefer its mutation/idempotency/transaction options instead of wrapping the mutation in an opaque command and assuming `rewind` saw it. Shell mutation evidence fingerprints dirty/untracked contents so an already-dirty file changing again is still detected. Do not reuse a successful verification result across a changed worktree; `verify_project` caching is opt-in and intentionally conservative.

For runtime/schema problems, use `agent_status(mode="doctor")`. Runtime identity is written only by a real server bootstrap; tests/imports must not overwrite it. Doctor can flag stale durable tasks/loops/transactions, schema-refresh recommendations, state read failures, and heap/cache pressure, but it must not silently delete resumable state. Keep long-run memory bounded: text caching is byte-budgeted, old MCP sessions are capped/evicted while stale IDs remain recoverable, and completed process/PTY/subagent plus LSP registries have finite retention.

Do not assume the ChatGPT host will auto-compact a long coding conversation. After important decisions or a returned `context_checkpoint_hint`, checkpoint a compact semantic summary/decisions/findings/blockers/next steps with `context_capsule`. If the hint sets `rollover_recommended=true`, finish the current safe boundary and continue in a fresh ChatGPT chat, then resume the capsule there. On a new/corrupted chat or when the user says continue and prior reasoning is missing, resume the capsule before rediscovering the repository. Local ChatGPT Plus can automatically snapshot machine state, but it cannot read hidden ChatGPT history, erase old host messages, or reconstruct unrecorded reasoning.

## `apply_patch` format

Single-file Codex-style hunk:

```text
@@
-old line
+new line
 context line
```

Multi-file format:

```text
*** Begin Patch
*** Update File: src/foo.ts
@@
-old
+new
*** End Patch
```

Use `dry_run: true` to preview a patch before writing when appropriate.

## Rewind/checkpoints

Local ChatGPT Plus captures checkpoints before file-editing MCP tools. Typical workflow:

1. `rewind(action="list")`
2. `rewind(action="preview", checkpoint_id="...")`
3. `rewind(action="restore", checkpoint_id="...")`

Shell commands that directly modify files are not captured by rewind.

## Paths

- Prefer absolute paths when the target is unambiguous.
- Relative paths resolve from the configured default cwd.
- For another repository, call `project_context(path)` to load its instructions, but still pass explicit paths/workspaces/working directories on later calls because ChatGPT may use a new MCP transport.

## Persistent task execution and recovery

`agent_task.status` is the **saved plan status**, not proof of live work. `agent_task get/list/resume` and the Admin Missions view also expose `execution.state` (`running`, `waiting`, `stalled`, `blocked`, or terminal), `running_worker_count`, `last_worker_exit`, and safe `recovery` guidance. A task without linked workers is classified as potentially stalled after 20 minutes; this is an observation, not proof that ChatGPT is idle. A running worker with no output is not automatically killed or marked failed.

When starting a task-owned runner, pass `task_id` to `start_process` or `subagent(action="spawn")`. Direct model-agent commands (`omp`, `codex`, etc.) and subagents also infer the ID when **exactly one** active/blocked task owns the same canonical workspace or Git common directory (including isolated worktrees). Ambiguous and unrelated work remain unlinked; explicit IDs are checked and cross-project links are rejected. A bare process label or prompt is never used to infer ownership. Older unlinked agent processes may be matched observationally in a task-status read; their saved operation records are not retroactively rewritten.

Failed, stopped, timed-out, or interrupted linked workers leave bounded, sanitized execution receipts. HTTP 401 authentication and 429 rate-limit failures are classified without saving provider secrets in task records. These events **never** silently retry edits, mark a plan step completed, or clean a dirty worktree. Review worker output and Git state, then resume explicitly. `verify_project(task_id=...)` now stores a bounded verification checkpoint (pass/fail, check count, Git revision, dirty flag, and worktree path) without completing the plan. If commits appear after the last plan update, the status reports possible Git/plan drift; a commit does not prove verification. Explicitly mark steps after reviewing that evidence.

As with other TypeScript source changes, compile with `pnpm run build` before restarting LCP. Its installed shell controller (`~/.local/bin/lcp`) is separate and only needs reinstallation if `scripts/lcp` or its installer changes. Do not restart LCP while other owned workers are performing work unless the operator intends to interrupt them.

## `lcp` controller — edits must be synced to the installed binary

The `lcp` shell controller is developed in `scripts/lcp` but **users run an
installed copy** at `~/.local/bin/lcp` (created by `scripts/lcp-install.sh`,
which copies the repo file and rewrites the per-user config). Edits to
`scripts/lcp` alone change nothing on the user's PATH.

**Whenever you modify `scripts/lcp` (or its installer), you MUST reinstall so
the change actually takes effect:**

```bash
scripts/lcp-install.sh      # copies scripts/lcp -> ~/.local/bin/lcp
# or: lcp _install          # same thing through an already-installed copy
```

Failure to do this is a silent no-op: the stale binary keeps running, and
behavioral changes (e.g. the Accessibility-pane `open` on `lcp off` /
`lcp mode full` / `lcp on --mode full`) appear to "not work." Verify your
change is live by checking the installed copy, e.g.
`grep -n 'computer_use_accessibility_note 1' ~/.local/bin/lcp`.

The source of truth is always `scripts/lcp`; the installed copy is a snapshot.
Keep the header comment in `scripts/lcp` and this section in sync if the
install path or command ever changes.

## Starting the server

**macOS**

```bash
cp .env.example .env
pnpm install --frozen-lockfile --ignore-scripts
pnpm audit signatures
pnpm audit --prod
pnpm audit
node scripts/check-osv-dependencies.mjs
pnpm rebuild
pnpm start          # build + MCP server, TUI and optional Admin UI
# or: sh scripts/start-macos.sh
# Terminal 2, if using Cloudflare Quick Tunnel:
pnpm run tunnel
# or another HTTPS tunnel, for example:
ssh -p 443 -R0:localhost:3000 a.pinggy.io
```

The built-in tunnel supervisor is opt-in (`LOCAL_CODER_MANAGE_TUNNEL`).
You must provision a macOS-compatible tunnel binary and credentials separately.
Set `LOCAL_CODER_ADMIN_ENABLED=false` for an MCP-only process if the Admin
UI and OAuth callbacks are not needed.

When `MCP_TOKEN` is configured, the connector endpoint must include it: `https://<tunnel>/mcp/<MCP_TOKEN>`. Treat that URL as a credential.

Health check: `http://127.0.0.1:3000/health`

Admin UI: `http://127.0.0.1:<ADMIN_PORT>/ui` (default port: `3001`)

The terminal dashboard is enabled automatically in an interactive terminal. TUI v2 lists **active projects first**, then connected-idle/offline workspaces, with per-project ChatGPT transport, active-tool, worker, and coding-loop counts. Current tools and workers show project scope, background workers show liveness/last activity, and the pinned Health footer surfaces transport loss while work continues, stalled/silent workers, and tunnel degradation. It also shows recent completions, durations, CPU, RSS, heap, tunnel status, and responsive compact layouts. Set `LOCAL_CODER_TUI=off` for traditional scrolling logs.

## Periodic stale checkout-process audit

Use this before stopping development runtimes left by another checkout. It is
diagnostic first; never kill by a broad name such as `node`, `omp`, or
`python`.

```bash
# List processes whose current working directory is a user checkout.
for pid in $(ps -axo pid=); do
  cwd=$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  case "$cwd" in
    "$HOME"/repos/*|"$HOME"/Projects/*|"$HOME"/src/*|"$HOME"/work/*)
      ps -p "$pid" -o pid=,ppid=,state=,etime=,command=
      printf '    cwd: %s\n' "$cwd"
      ;;
  esac
done

# Check listeners before deciding whether a runtime is stale.
lsof -nP -iTCP -sTCP:LISTEN
```

For each candidate, record the exact PID, parent PID, checkout path, elapsed
time, command, and listeners. Exclude the current checkout, active shells,
system services, browser processes, and managed daemons unless their owner
explicitly requested them stopped. Stop only a reviewed PID list:

```bash
kill -TERM <pid>...
sleep 2
kill -KILL <pid>...  # only exact PIDs still alive after TERM
```

Re-run the process and listener checks. Confirm the current checkout's
processes and listeners remain intact. Never use `pkill`/`killall` with a
generic runtime name, and do not delete state directories to clean up a
process.

## Troubleshooting

| Problem | Action |
|---|---|
| Access denied | Verify the active Local ChatGPT Plus permission profile, configured roots, and OS permissions. The explicitly selected `open` profile does not bypass OS ACLs. |
| Patch context not found | Re-read the file and add enough unchanged context around the hunk. |
| ChatGPT asks on every call | Review connector permissions and `CHATGPT_AUTO_APPROVE`. |
| Connection failed | Ensure both server and tunnel are running, and use the correct HTTPS connector URL. |
| Tool not found | Check the active profile/overrides with `agent_status` or the Admin UI. |
| Connector hangs after a schema update | Run `pnpm run build`, restart the server, refresh the connector, and start a new chat. |
| `stream canceled` | The MCP stream was closed/reset; keep services stable, refresh, and reconnect. |

Some wrapper tools may be rejected by the host client's safety layer even when the same local operation is valid. Where appropriate, use an equivalent `run_command` fallback and verify the result.