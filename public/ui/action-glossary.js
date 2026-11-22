/*
 * Action glossary — deterministic, human-readable explainer for Admin activity.
 *
 * Loaded ahead of app.js so the UI can describe every tool it renders without
 * shipping tool source. Pure (no DOM) so it can be unit-tested in Node via
 * scripts/test-action-glossary.mjs. Keep tool names in sync with
 * src/lib/tool-profile.ts LOCAL_TOOL_CATALOG.
 *
 * Safety: descriptions are static short text only. They never embed command
 * text, arguments or secrets — raw arguments are surfaced exclusively by the
 * server-side sanitizer and must not be reconstructed here.
 */
(function (global) {
  "use strict";

  // Side-effect classes. danger=true means the tool can run untrusted code,
  // spawn processes, or mutate live state — worth highlighting in the UI.
  const SIDE = {
    read:     { key: "read",     label: "read-only",                     danger: false },
    write:    { key: "write",    label: "writes files",                  danger: false },
    git:      { key: "git",      label: "git (may mutate history)",      danger: false },
    process:  { key: "process",  label: "manages processes/session",     danger: true  },
    run:      { key: "run",      label: "runs code/commands",            danger: true  },
    state:    { key: "state",    label: "reads or alters tool state",    danger: false },
    network:  { key: "network",  label: "network access",                danger: false },
    observe:  { key: "observe",  label: "observes browser/desktop UI",  danger: false },
    computer: { key: "computer", label: "changes browser/desktop UI",   danger: true  },
    unknown:  { key: "unknown",  label: "effect unknown",                danger: false },
  };

  // tool -> [verb, detail, sideKey]. `verb` mirrors the existing UI-friendly
  // phrasing; `detail` is the human explanation; `side` is the effect class.
  const ENTRIES = {
    // Filesystem
    "read_text_file":          ["Read file", "Reads a file's text content.", "read"],
    "read_files":              ["Read files", "Reads one or more files.", "read"],
    "read_file_base64":        ["Read file (base64)", "Reads a file as base64-encoded data.", "read"],
    "write_file":              ["Wrote file", "Creates or overwrites a text file.", "write"],
    "write_file_base64":       ["Wrote binary file", "Writes base64-decoded data to a file.", "write"],
    "edit_file":               ["Edited source", "Applies a targeted text edit to a file.", "write"],
    "multi_edit":              ["Edited multiple files", "Applies several atomic text edits.", "write"],
    "replace_regex":           ["Replaced text", "Replaces regex-matched text in a file.", "write"],
    "apply_patch":             ["Applied a patch", "Applies a code-style patch to files.", "write"],
    "list_directory":          ["Listed a directory", "Lists a directory's entries.", "read"],
    "glob":                    ["Listed matching files", "Finds files by name pattern.", "read"],
    "grep":                    ["Searched the codebase", "Searches text with patterns.", "read"],
    "delete_file":             ["Deleted file", "Deletes a file.", "write"],
    "create_directory":        ["Created directory", "Creates a directory.", "write"],
    "delete_directory":        ["Deleted directory", "Deletes a directory (recursive).", "write"],
    "copy_file":               ["Copied file", "Copies a file.", "write"],
    "move_file":               ["Moved file", "Moves or renames a file.", "write"],
    "search_files":            ["Searched files", "Searches across files.", "read"],
    "directory_tree":          ["Showed directory tree", "Shows a directory tree.", "read"],
    "list_allowed_directories":["Listed allowed roots", "Lists the directory roots the agent may access.", "read"],

    // Shell / processes
    "run_command":             ["Ran a command", "Executes a shell command.", "run"],
    "run_commands_parallel":   ["Ran commands in parallel", "Runs independent commands concurrently.", "run"],
    "shell_status":            ["Checked shell", "Shows shell session state.", "state"],
    "shell_reset":             ["Reset shell", "Clears shell session state.", "state"],
    "start_process":           ["Started a background process", "Starts a long-running background process.", "process"],
    "process_status":          ["Checked a process", "Reports a background process's status.", "state"],
    "process_history":         ["Process history", "Lists background-process history.", "read"],
    "process_output":          ["Read process output", "Reads a background process's buffered output.", "read"],
    "process_input":           ["Sent input to a process", "Sends input to a background process.", "process"],
    "stop_process":            ["Stopped a process", "Stops a background process.", "process"],
    "clear_processes":         ["Cleared processes", "Clears completed process history.", "state"],
    "pty":                     ["Opened an interactive terminal", "Opens an interactive terminal session.", "process"],

    // Git
    "git_status":              ["Checked Git status", "Shows Git working-tree status.", "read"],
    "git_diff":                ["Showed a Git diff", "Shows a diff between revisions.", "read"],
    "git_log":                 ["Showed Git history", "Shows Git commit history.", "read"],
    "git_worktree":            ["Created a Git worktree", "Creates an isolated Git worktree.", "git"],
    "git_add":                 ["Staged changes", "Stages working-tree changes.", "git"],
    "git_commit":              ["Created a Git commit", "Creates a Git commit.", "git"],
    "git_branch":              ["Managed branches", "Lists or creates Git branches.", "git"],
    "git_checkout":            ["Switched branches", "Switches the active Git branch.", "git"],
    "git_restore":             ["Restored a file", "Restores a file from the index or HEAD.", "git"],
    "git_push":                ["Pushed to remote", "Pushes commits to a remote.", "network"],
    "git_pull":                ["Pulled from remote", "Pulls commits from a remote.", "network"],
    "git_stash":               ["Stashed changes", "Stashes uncommitted changes.", "git"],
    "git_reset":               ["Reset Git state", "Resets Git index or history.", "git"],

    // Context / agent state
    "list_skills":             ["Listed skills", "Lists available skills.", "read"],
    "load_skill":              ["Loaded a skill", "Loads a skill's instructions.", "read"],
    "project_context":         ["Loaded project context", "Loads project context files.", "read"],
    "agent_status":            ["Agent status", "Reports agent/permission/tool state.", "state"],
    "remember":                ["Recorded a memory", "Persists a note in project memory.", "write"],
    "load_path_rules":         ["Loaded path rules", "Loads path-scoped rules.", "read"],
    "agent_task":              ["Task state", "Persists or reviews task state.", "state"],
    "inspect_project":         ["Inspected project", "Inspects project structure.", "read"],
    "verify_project":          ["Verified project", "Runs or checks cached project verification.", "state"],
    "repo_intel":              ["Repo intelligence", "Queries code intelligence.", "read"],
    "edit_transaction":        ["Edit transaction", "Groups file edits into a transactional span.", "write"],
    "coding_loop_status":      ["Coding-loop status", "Shows coding-loop state.", "state"],
    "coding_loop":             ["Coding loop", "Runs or steps a coding loop.", "run"],
    "context_capsule":         ["Context capsule", "Persists or reads a resumable context capsule.", "state"],
    "subagent":                ["Delegated to a subagent", "Delegates work to a separate subagent.", "run"],
    "delegate_status":         ["Delegate status", "Detects installed external agent CLIs.", "state"],
    "node_repl":               ["Node REPL", "Runs an interactive Node REPL.", "run"],
    "ponytail_turn":           ["Ponytail turn", "Runs a ponytail-mode reasoning turn.", "state"],
    "rewind":                  ["Rewind", "Lists, previews or restores file-edit checkpoints.", "write"],
    "view_image":              ["Viewed image", "Inspects a local image.", "read"],
    "lsp":                     ["Language server", "Queries a language server (definitions, diagnostics).", "read"],

    // Upstream MCP bridge
    "computer_observe":        ["Observed browser/desktop", "Captures the state of browser or desktop UI.", "observe"],
    "computer_act":            ["Acted on browser/desktop", "Performs an action on browser or desktop UI.", "computer"],
    "mcp_servers":             ["Listed MCP servers", "Lists upstream MCP servers.", "state"],
    "mcp_tools":               ["Listed MCP tools", "Lists tools exposed by upstream MCP servers.", "read"],
    "mcp_call":                ["Called MCP tool", "Calls an upstream MCP server's tool.", "network"],

    // MCP session actions (observed, not native registry tools).
    "initialize":              ["Initialized MCP session", "Performs the MCP session handshake.", "state"],
    "tools/list":              ["Discovered MCP tools", "Lists tools exposed by the session.", "read"],
    "tools/call":              ["Called a tool", "Invokes a tool through the MCP session.", "run"],
  };

  const UNKNOWN = [
    "Tool call",
    "Not in the glossary — exact behavior unknown. Only sanitized fields are shown; raw arguments and secrets are never surfaced.",
    "unknown",
  ];

  const describe = function (tool) {
    const e = ENTRIES[tool] || UNKNOWN;
    const side = SIDE[e[2]] || SIDE.read;
    return { verb: e[0], detail: e[1], side: { key: side.key, label: side.label, danger: side.danger } };
  };

  const sideEffectOf = function (tool) {
    return describe(tool).side;
  };

  const isKnown = function (tool) {
    return Object.prototype.hasOwnProperty.call(ENTRIES, tool);
  };

  /*
   * Error classification with guidance. Returns null for unclassified
   * statuses so the UI never invents advice. Key semantic: an HTTP status is
   * a transport/upstream signal, NOT the tool's own effect — when present it
   * cannot confirm what (if anything) the tool call did locally.
   */
  const statusGuidance = function (status, httpStatus) {
    if (!status || status === "ok") return null;
    if (httpStatus != null) {
      if (httpStatus === 401 || httpStatus === 403) {
        return "Transport/upstream refused access (HTTP " + httpStatus + "). This is a connectivity/auth failure, not the tool's own result — the local effect, if any, is unknown.";
      }
      if (httpStatus === 429) {
        return "Transport/upstream rate-limited (HTTP 429). The tool effect is separate from the transport result.";
      }
      if (httpStatus >= 500) {
        return "Upstream/server error (HTTP " + httpStatus + "). HTTP transport failure only — it does not confirm the tool's local effect.";
      }
    }
    if (status === "blocked") {
      return "Blocked or interrupted by policy/permissions. Check the recorded operation state before assuming no side effects occurred.";
    }
    if (status === "error") {
      return "The tool call failed (non-zero exit, thrown error, or rejected request). Check the sanitized summary; raw arguments are not shown.";
    }
    return null;
  };

  global.ActionGlossary = { describe: describe, sideEffectOf: sideEffectOf, isKnown: isKnown, statusGuidance: statusGuidance, SIDE: SIDE };
})(typeof globalThis !== "undefined" ? globalThis : this);