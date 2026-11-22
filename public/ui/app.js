const ENV_KEYS = [
  "WORKSPACE_PATH",
  "EXTRA_WORKSPACE_PATHS",
  "PORT",
  "ADMIN_PORT",
  "CHATGPT_AUTO_APPROVE",
  "CHATGPT_TOOL_PROFILE",
  "SHELL_TIMEOUT",
  "GIT_TIMEOUT_MS",
  "MCP_AGENT_TASK_STATE_DIR",
  "MCP_OPERATION_STATE_DIR",
  "MCP_EDIT_TRANSACTION_STATE_DIR",
  "MCP_CODING_LOOP_STATE_DIR",
  "MCP_CONTEXT_CAPSULE_STATE_DIR",
  "MCP_CONTEXT_CAPSULE_TOOL_CALLS",
  "MCP_CONTEXT_CAPSULE_RESULT_BYTES",
  "MCP_CONTEXT_CAPSULE_ROLLOVER_CYCLES",
  "MCP_CODING_LOOP_WORKTREE_ROOT",
  "MCP_RESULT_STATE_DIR",
  "MCP_PARALLEL_BATCH_STATE_DIR",
  "MCP_IDEMPOTENCY_STATE_DIR",
  "MCP_PROJECT_REGISTRY_PATH",
  "MCP_VERIFICATION_CACHE_STATE_DIR",
  "MCP_VERIFICATION_CACHE_TTL_SECONDS",
  "MCP_RUNTIME_IDENTITY_PATH",
  "MCP_EPHEMERAL_STATE_RETENTION_DAYS",
  "MCP_STALE_STATE_HOURS",
  "MCP_SESSION_RECOVERY",
  "MCP_SESSION_DELETE_GRACE_MS",
  "MCP_JSON_RESPONSE",
  "MCP_SSE_KEEPALIVE_MS",
  "CHECKPOINT_ENABLED",
  "MCP_UPSTREAM_CONFIG",
  "POST_EDIT_HOOKS_CONFIG",
];

const TITLES = {
  dashboard: "Overview",
  servers: "MCP Servers",
  import: "Import",
  activity: "Activity",
  missions: "Missions",
  project: "Project context",
  settings: "Settings",
  logs: "Raw status",
};

const SOURCE_LABELS = {
  cursor: "Cursor",
  claude: "Claude Code",
  opencode: "OpenCode",
};

let upstreamConfig = { servers: [] };
let editingServerId = null;
let activityPollTimer = null;
let activityEventSource = null;
let activityReconnectTimer = null;
let activityReconnectAttempt = 0;
let activityContextRefreshing = false;
let activityContextLastTick = Date.now();
let activitySeenIds = new Set();
let activityPaused = false;
let dashboardRuntimeTimer = null;
let dashboardRuntimeRefreshing = false;
let dashboardHealthCache = null;
// Expanded Overview rows survive the 5s re-render: keyed by the stable tool-call id.
let recentExpanded = new Set();
let recentDetailsSeq = 0;

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = isError ? "toast error" : "toast";
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3200);
}

let adminCsrf = "";
// Never trust the localhost session cookie alone: cookies cross ports, while
// sessionStorage is isolated by origin (including the Admin port).
const ADMIN_PROOF_STORAGE_KEY = "lcp-admin-origin-proof";
function readStoredAdminProof() {
  try { return sessionStorage.getItem(ADMIN_PROOF_STORAGE_KEY) || ""; } catch { return ""; }
}
function storeAdminProof(proof) {
  try { sessionStorage.setItem(ADMIN_PROOF_STORAGE_KEY, proof); }
  catch { throw new Error("Browser session storage is required for secure Admin login."); }
}
function clearStoredAdminProof() {
  try { sessionStorage.removeItem(ADMIN_PROOF_STORAGE_KEY); } catch {}
}
let adminProof = readStoredAdminProof();
let adminTokenSession = false;

function passkeysAvailableHere() {
  return location.hostname === "localhost" && window.isSecureContext &&
    Boolean(window.SimpleWebAuthnBrowser?.browserSupportsWebAuthn?.());
}

async function refreshAdminPasskeys() {
  const enabled = passkeysAvailableHere();
  const note = document.getElementById("admin-passkey-note");
  const signIn = document.getElementById("admin-passkey-login");
  document.getElementById("admin-add-passkey").hidden = !(enabled && adminTokenSession);
  document.getElementById("admin-manage-passkeys").hidden = !(enabled && adminTokenSession);
  if (!enabled) {
    const home = `http://localhost:${location.port}/ui/`;
    note.textContent = location.hostname === "localhost"
      ? "This browser does not support WebAuthn passkeys; use the Admin token."
      : `Passkeys are available from ${home}. Your Admin token still works here.`;
    signIn.hidden = true;
    return;
  }
  note.textContent = "Passkeys are saved by your browser's credential provider (Apple Passwords on macOS).";
  try {
    const response = await fetch("/api/auth/passkeys/status", { cache: "no-store" });
    const info = await response.json();
    signIn.hidden = !info.registered;
  } catch {
    signIn.hidden = true;
  }
}

function showAdminLogin() {
  const dialog = document.getElementById("admin-login");
  if (dialog && !dialog.open) dialog.showModal();
}

async function restoreAdminSession() {
  if (!adminProof) {
    adminCsrf = "";
    showAdminLogin();
    return false;
  }
  const response = await fetch("/api/auth/session", {
    cache: "no-store",
    headers: { "X-LCP-Admin-Proof": adminProof },
  });
  if (!response.ok) {
    adminCsrf = "";
    adminProof = "";
    clearStoredAdminProof();
    showAdminLogin();
    return false;
  }
  const session = await response.json();
  adminCsrf = session.csrf || "";
  adminTokenSession = Boolean(session.viaToken);
  await refreshAdminPasskeys();
  return Boolean(adminCsrf);
}

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (adminProof) headers["X-LCP-Admin-Proof"] = adminProof;
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers["X-LCP-Admin-CSRF"] = adminCsrf;
  const res = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    adminCsrf = "";
    adminProof = "";
    clearStoredAdminProof();
    showAdminLogin();
  }
  if (!res.ok) {
    const error = new Error(data.error || `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

document.getElementById("admin-login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("admin-login-token");
  const error = document.getElementById("admin-login-error");
  const button = document.getElementById("admin-login-submit");
  button.disabled = true;
  error.textContent = "";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: input.value }),
    });
    input.value = "";
    if (!response.ok) {
      error.textContent = response.status === 429 ? "Too many attempts. Try again later." : "Invalid Admin credential.";
      return;
    }
    const { proof } = await response.json();
    if (typeof proof !== "string" || proof.length < 32) throw new Error("Missing origin session proof");
    adminProof = proof;
    storeAdminProof(proof);
    // Reload without retaining the token; the server cookie is HttpOnly.
    window.location.reload();
  } catch (err) {
    input.value = "";
    error.textContent = err?.message || "Could not contact the local Admin service.";
  } finally {
    button.disabled = false;
  }
});

document.getElementById("admin-logout").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    adminCsrf = "";
    adminProof = "";
    clearStoredAdminProof();
    window.location.reload();
  }
});

document.getElementById("admin-passkey-login").addEventListener("click", async () => {
  const button = document.getElementById("admin-passkey-login");
  const error = document.getElementById("admin-login-error");
  button.disabled = true;
  error.textContent = "";
  try {
    if (!passkeysAvailableHere()) throw new Error("Use localhost in a browser with passkey support.");
    const optionsResult = await fetch("/api/auth/passkeys/authentication/options", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    });
    if (!optionsResult.ok) throw new Error("Could not start passkey authentication.");
    const { options } = await optionsResult.json();
    const credential = await window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
    const verification = await fetch("/api/auth/passkeys/authentication/verify", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(credential),
    });
    if (!verification.ok) throw new Error("Passkey verification failed. Try again or use the Admin token.");
    const { proof } = await verification.json();
    if (typeof proof !== "string" || proof.length < 32) throw new Error("Missing origin session proof");
    adminProof = proof;
    storeAdminProof(proof);
    window.location.reload();
  } catch (err) {
    error.textContent = err?.name === "NotAllowedError"
      ? "Passkey prompt cancelled."
      : (err?.message || "Passkey login failed.");
  } finally {
    button.disabled = false;
  }
});

document.getElementById("admin-add-passkey").addEventListener("click", async () => {
  const button = document.getElementById("admin-add-passkey");
  button.disabled = true;
  try {
    if (!passkeysAvailableHere() || !adminTokenSession) throw new Error("Sign in with your Admin token on localhost first.");
    const { options } = await api("/api/auth/passkeys/registration/options", { method: "POST" });
    const credential = await window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
    await api("/api/auth/passkeys/registration/verify", {
      method: "POST", body: JSON.stringify(credential),
    });
    toast("Passkey registered. You can now use Touch ID or your device passcode to sign in.");
    await refreshAdminPasskeys();
  } catch (err) {
    toast(err?.name === "NotAllowedError" ? "Passkey enrollment cancelled." : (err?.message || "Passkey enrollment failed."), true);
  } finally {
    button.disabled = false;
  }
});

document.getElementById("admin-passkeys-close").addEventListener("click", () => {
  document.getElementById("admin-passkeys-dialog").close();
});

document.getElementById("admin-manage-passkeys").addEventListener("click", async () => {
  try {
    const response = await api("/api/auth/passkeys/registered");
    if (!response.canManage) throw new Error("Sign in using the Admin token to manage passkeys.");
    const list = document.getElementById("admin-passkey-list");
    list.replaceChildren();
    for (const item of response.credentials) {
      const row = document.createElement("div");
      row.className = "inline-form";
      const label = document.createElement("span");
      label.textContent = `Passkey registered ${new Date(item.createdAt).toLocaleString()} (${item.id.slice(0, 8)}…)`;
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "btn ghost";
      revoke.textContent = "Remove";
      revoke.addEventListener("click", async () => {
        if (!window.confirm("Remove this passkey from the Admin server? It will no longer authenticate here.")) return;
        try {
          await api("/api/auth/passkeys/revoke", {
            method: "POST", body: JSON.stringify({ id: item.id }),
          });
          row.remove();
          await refreshAdminPasskeys();
          toast("Passkey revoked on the server.");
        } catch (err) {
          toast(err.message, true);
        }
      });
      row.append(label, revoke);
      list.append(row);
    }
    if (!response.credentials.length) {
      const note = document.createElement("p");
      note.textContent = "No passkeys registered yet. Use Add passkey.";
      list.append(note);
    }
    document.getElementById("admin-passkeys-dialog").showModal();
  } catch (err) {
    toast(err.message, true);
  }
});

void refreshAdminPasskeys();

function badge(health) {
  if (health === "connected") return '<span class="badge ok">connected</span>';
  if (health === "disabled") return '<span class="badge off">disabled</span>';
  return `<span class="badge bad">${health || "unknown"}</span>`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatElapsed(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function lastRuntimeActivityMs(runtime) {
  let latest = Number.NEGATIVE_INFINITY;
  for (const item of runtime?.active || []) latest = Math.max(latest, Number(item.started_ms) || 0);
  const recent = runtime?.recent?.[0]?.finished_at ? Date.parse(runtime.recent[0].finished_at) : Number.NaN;
  if (Number.isFinite(recent)) latest = Math.max(latest, recent);
  return Number.isFinite(latest) && latest > 0 ? latest : null;
}

function runtimeKind(kind) {
  const value = String(kind || "MCP").toLowerCase();
  return `<span class="runtime-kind ${esc(value)}">${esc(String(kind || "MCP"))}</span>`;
}

// The in-process supervisor may be disabled while the real tunnel is managed
// by the installed macOS launchd job. Display the verified observer separately
// from the internal supervisor rather than incorrectly reporting tunnel DOWN.
function tunnelDisplay(tunnel) {
  const state = String(tunnel?.status || "unknown").toLowerCase();
  const manager = String(tunnel?.management || "");
  if (manager === "launchd") {
    return {
      label: state.toUpperCase(),
      detail: `launchd-managed · health :${tunnel.health_port} · ${tunnel.restarts ?? 0} restart(s)`,
      healthy: state === "online",
    };
  }
  if (manager === "not_monitored" || (state === "disabled" && !tunnel?.managed)) {
    return {
      label: "NOT MONITORED",
      detail: "Internal supervisor off · external tunnel not verified",
      healthy: false,
    };
  }
  return {
    label: state.toUpperCase(),
    detail: `LCP-managed${tunnel?.health_port ? ` · health :${tunnel.health_port}` : ""} · ${tunnel?.restarts ?? 0} restart(s)`,
    healthy: state === "online",
  };
}

function renderRuntimeOverview(runtimeInfo) {
  const runtime = runtimeInfo.runtime || {};
  const identity = runtimeInfo.identity || {};
  const now = Date.now();
  const active = Array.isArray(runtime.active) ? runtime.active : [];
  const recent = Array.isArray(runtime.recent) ? runtime.recent : [];
  const processes = Array.isArray(runtimeInfo.processes) ? runtimeInfo.processes : [];
  const tasks = Array.isArray(runtimeInfo.agent_tasks) ? runtimeInfo.agent_tasks : [];
  const operations = Array.isArray(runtimeInfo.operations) ? runtimeInfo.operations : [];
  const loops = Array.isArray(runtimeInfo.coding_loops) ? runtimeInfo.coding_loops : [];
  const transactions = Array.isArray(runtimeInfo.edit_transactions) ? runtimeInfo.edit_transactions : [];
  const workers = [runtimeInfo.processes, runtimeInfo.ptys, runtimeInfo.subagents]
    .flatMap((items) => Array.isArray(items) ? items : [])
    .filter((item) => item.running).length;
  const latest = lastRuntimeActivityMs(runtime);

  const lastTool = latest == null ? "Last tool —" : `Last tool ${formatElapsed(now - latest)} ago`;
  document.getElementById("overview-last-tool").textContent = lastTool;
  document.getElementById("overview-updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour12: false })}`;
  document.getElementById("dash-active-count").textContent = String(active.length);
  const dot = document.getElementById("overview-dot");
  dot.className = `status-dot ${active.length ? "busy" : "online"}`;
  document.getElementById("overview-state").textContent = active.length ? "Working" : "Online";

  const activeStat = document.getElementById("stat-active-tools");
  const workerStat = document.getElementById("stat-workers");
  const callsStat = document.getElementById("stat-calls");
  const errorsStat = document.getElementById("stat-errors");
  if (activeStat) activeStat.textContent = String(active.length);
  if (workerStat) workerStat.textContent = String(workers);
  if (callsStat) callsStat.textContent = String(runtime.total_calls ?? 0);
  if (errorsStat) errorsStat.textContent = String(runtime.total_errors ?? 0);
  const runStat = document.getElementById("stat-run-id");
  const schemaStat = document.getElementById("stat-schema");
  if (runStat) runStat.textContent = identity.run_id ? String(identity.run_id).replace(/^run_/, "").slice(0, 12) : "—";
  if (schemaStat) schemaStat.textContent = identity.schema_hash ? String(identity.schema_hash).slice(0, 12) : "—";

  const sessionEl = document.getElementById("dash-sessions");
  const sessionCount = document.getElementById("dash-session-count");
  const workspaceMap = new Map();
  const addWorkspace = (root, kind, label) => {
    const normalized = root ? String(root).replace(/[\\/]+$/, "") : "__machine__";
    const key = normalized.toLowerCase();
    const row = workspaceMap.get(key) || {
      root: root || null,
      label: root ? (String(root).split(/[/\\]/).filter(Boolean).pop() || "Project") : "Machine / host",
      tools: 0, jobs: 0, tasks: 0, loops: 0, transactions: 0,
    };
    row[kind] += 1;
    if (label && !row.detail) row.detail = label;
    workspaceMap.set(key, row);
  };
  for (const item of active) if (item.project_root) addWorkspace(item.project_root, "tools", item.tool);
  for (const item of processes.filter((item) => item.running)) addWorkspace(item.project_root || null, "jobs", item.label || item.command);
  for (const task of tasks.filter((task) => task.status === "active" || task.status === "blocked")) addWorkspace(task.workspace, "tasks", task.title);
  for (const loop of loops.filter((loop) => loop.status === "active")) addWorkspace(loop.workspace, "loops", loop.goal);
  for (const tx of transactions.filter((tx) => tx.status === "active")) addWorkspace(tx.workspace, "transactions", tx.label || tx.id);
  const workspaceRows = [...workspaceMap.values()].sort((a, b) => {
    const total = (row) => row.tools + row.jobs + row.tasks + row.loops + row.transactions;
    return total(b) - total(a);
  });
  if (sessionCount) sessionCount.textContent = String(workspaceRows.length);
  if (sessionEl) {
    sessionEl.innerHTML = workspaceRows.length
      ? workspaceRows.slice(0, 16).map((row) => {
          const summary = [
            row.tools ? `${row.tools} tool${row.tools === 1 ? "" : "s"}` : "",
            row.jobs ? `${row.jobs} job${row.jobs === 1 ? "" : "s"}` : "",
            row.tasks ? `${row.tasks} task${row.tasks === 1 ? "" : "s"}` : "",
            row.loops ? `${row.loops} loop${row.loops === 1 ? "" : "s"}` : "",
            row.transactions ? `${row.transactions} transaction${row.transactions === 1 ? "" : "s"}` : "",
          ].filter(Boolean).join(" · ");
          const liveness = processes
            .filter((item) => item.running && (row.root ? item.project_root === row.root : !item.project_root))
            .map((item) => item.liveness);
          const warn = liveness.includes("possibly_stalled") || liveness.includes("silent");
          return `<div class="runtime-row session-row">
            <span class="runtime-kind ${row.root ? "edit" : "operation"}">${row.root ? "PROJ" : "HOST"}</span>
            <span class="runtime-tool ${warn ? "runtime-state-warn" : "runtime-state-ok"}" title="${esc(row.root || "Machine / host")}">
              <span class="session-workspace"><strong>${esc(row.label)}</strong></span>
            </span>
            <span class="runtime-summary" title="${esc(row.root || row.detail || summary)}">${esc(summary || row.detail || "active")}</span>
            <span class="runtime-time">${warn ? "check liveness" : "active"}</span>
          </div>`;
        }).join("")
      : '<div class="runtime-empty">No active project or machine work.</div>';
  }

  const activeEl = document.getElementById("dash-active");
  activeEl.innerHTML = active.length
    ? active.slice(0, 8).map((item) => `<div class="runtime-row">
        ${runtimeKind(item.kind)}
        <span class="runtime-tool" title="${esc(item.tool)}">${esc(item.tool)}</span>
        <span class="runtime-summary" title="${esc(item.summary)}">${esc(item.summary || "processing")}</span>
        <span class="runtime-time">${formatElapsed(now - item.started_ms)}</span>
      </div>`).join("")
    : '<div class="runtime-empty">Idle — waiting for ChatGPT tool calls.</div>';

  const recentEl = document.getElementById("dash-recent");
  recentEl.innerHTML = recent.length
    ? recent.slice(0, 20).map(renderRecentRow).join("")
    : '<div class="runtime-empty">No completed tool calls in this server process yet.</div>';
  // Drop expanded-state keys that no longer have a visible row so the set stays bounded.
  if (recent.length) {
    const visible = new Set(recent.slice(0, 20).map((item) => item.id));
    for (const id of recentExpanded) if (!visible.has(id)) recentExpanded.delete(id);
  }

  const usage = Array.isArray(runtime.usage) ? runtime.usage : [];
  const usageEl = document.getElementById("dash-usage");
  const usageCount = document.getElementById("dash-usage-count");
  if (usageCount) usageCount.textContent = String(usage.length);
  if (usageEl) {
    usageEl.innerHTML = usage.length
      ? usage.slice(0, 10).map((item) => {
          const summary = `${item.calls || 0} call(s) · p50 ${formatElapsed(item.p50_duration_ms || 0)} · p95 ${formatElapsed(item.p95_duration_ms || 0)} · avg ${formatBytes(item.average_result_bytes || 0)}${item.repeated_calls ? ` · ${item.repeated_calls} repeat(s)` : ""}`;
          return `<div class="runtime-row">
            <span class="runtime-kind read">PERF</span>
            <span class="runtime-tool" title="${esc(item.tool)}">${esc(item.tool)}</span>
            <span class="runtime-summary" title="${esc(summary)}">${esc(summary)}</span>
            <span class="runtime-time">${formatBytes(item.total_result_bytes || 0)}</span>
          </div>`;
        }).join("")
      : '<div class="runtime-empty">No tool telemetry yet.</div>';
  }

  const persistent = runtimeInfo.persistent_telemetry || null;
  const persistentEl = document.getElementById("dash-persistent-telemetry");
  const persistentCount = document.getElementById("dash-persistent-count");
  const days7 = persistent?.windows?.days_7;
  const days30 = persistent?.windows?.days_30;
  if (persistentCount) persistentCount.textContent = String(days30?.calls || 0);
  if (persistentEl) {
    if (!persistent || !persistent.canonical_runtime_records) {
      persistentEl.innerHTML = '<div class="runtime-empty">Canonical Phase 6 telemetry starts accumulating after this build is restarted.</div>';
    } else {
      const summaryRows = [
        { label: "7 DAYS", value: days7 },
        { label: "30 DAYS", value: days30 },
      ];
      const summaryHtml = summaryRows.map(({ label, value }) => {
        const text = String(value?.calls || 0) + " call(s) · " +
          String(value?.runtime_errors || 0) + " runtime error(s) · " +
          String(value?.domain_failures || 0) + " domain failure(s) · " +
          String(value?.timeouts || 0) + " timeout(s)";
        return '<div class="runtime-row">' +
          '<span class="runtime-kind read">' + esc(label) + '</span>' +
          '<span class="runtime-tool">' + formatBytes(value?.total_result_bytes || 0) + '</span>' +
          '<span class="runtime-summary" title="' + esc(text) + '">' + esc(text) + '</span>' +
          '<span class="runtime-time">' + String(persistent.source_files || 0) + ' log(s)</span>' +
          '</div>';
      }).join("");
      const toolHtml = (days30?.tools || []).slice(0, 8).map((item) => {
        const summary = String(item.calls) + " call(s) · runtime " + String(item.runtime_errors) +
          " · domain " + String(item.domain_failures) + " · timeout " + String(item.timeouts) +
          " · p95 " + formatElapsed(item.p95_duration_ms || 0);
        return '<div class="runtime-row">' +
          '<span class="runtime-kind read">30D</span>' +
          '<span class="runtime-tool" title="' + esc(item.tool) + '">' + esc(item.tool) + '</span>' +
          '<span class="runtime-summary" title="' + esc(summary) + '">' + esc(summary) + '</span>' +
          '<span class="runtime-time">' + formatBytes(item.total_result_bytes || 0) + '</span>' +
          '</div>';
      }).join("");
      persistentEl.innerHTML = summaryHtml + toolHtml;
    }
  }

  const resumable = tasks.filter((task) => task.status === "active" || task.status === "blocked");
  document.getElementById("dash-task-count").textContent = String(resumable.length);
  const taskEl = document.getElementById("dash-agent-task");
  taskEl.innerHTML = resumable.length
    ? resumable.slice(0, 4).map((task) => {
        const progress = task.progress || {};
        const step = progress.current_step || progress.next_step;
        const executionState = task.execution?.state || "waiting";
        const stateClass = ["stalled", "blocked"].includes(executionState) ? "runtime-state-error" : "runtime-state-ok";
        const project = String(task.workspace || "").split(/[/\\]/).filter(Boolean).pop() || "project";
        return `<div class="runtime-row agent-task-row">
          <span class="runtime-kind task">TASK</span>
          <span class="runtime-tool ${stateClass}" title="${esc(task.execution?.reason || task.title)}">${esc(project)} · ${esc(task.title)}</span>
          <span class="runtime-summary" title="${esc(task.execution?.reason || step?.title || task.objective)}">${esc(executionState)} · ${esc(step?.title || task.objective)}</span>
          <span class="runtime-time">${progress.percent ?? 0}%</span>
        </div>`;
      }).join("")
    : '<div class="runtime-empty">No active persistent agent task.</div>';

  document.getElementById("dash-operation-count").textContent = String(operations.length);
  const operationsEl = document.getElementById("dash-operations");
  operationsEl.innerHTML = operations.length
    ? operations.slice(0, 8).map((operation) => {
        const status = operation.effective_status || operation.status || "unknown";
        const stateClass = ["completed", "running"].includes(status) ? "runtime-state-ok" : "runtime-state-error";
        const finished = operation.finished_at ? Date.parse(operation.finished_at) : Number.NaN;
        const started = Date.parse(operation.started_at || "");
        const duration = Number.isFinite(finished) && Number.isFinite(started)
          ? formatElapsed(finished - started)
          : Number.isFinite(started) ? formatElapsed(now - started) : "—";
        return `<div class="runtime-row operation-row">
          <span class="runtime-kind operation">${esc(status.toUpperCase().slice(0, 5))}</span>
          <span class="runtime-tool ${stateClass}" title="${esc(operation.command)}">${esc(operation.label || operation.id)}</span>
          <span class="runtime-summary" title="${esc(operation.command)}">${esc(operation.command)}</span>
          <span class="runtime-time">${duration}</span>
        </div>`;
      }).join("")
    : '<div class="runtime-empty">No persistent background operations yet.</div>';

  const activeLoops = loops.filter((loop) => loop.status === "active");
  document.getElementById("dash-loop-count").textContent = String(activeLoops.length);
  const loopsEl = document.getElementById("dash-loops");
  loopsEl.innerHTML = loops.length
    ? loops.slice(0, 8).map((loop) => {
        const status = loop.status || "unknown";
        const phase = loop.phase || status;
        const stateClass = ["active", "completed"].includes(status) ? "runtime-state-ok" : "runtime-state-error";
        const attempt = `${loop.attempts ?? 0}/${loop.max_attempts ?? 0}`;
        const mode = loop.isolation?.mode === "worktree" ? "worktree" : "main";
        const updated = Date.parse(loop.updated_at || "");
        const age = Number.isFinite(updated) ? `${formatElapsed(now - updated)} ago` : "—";
        const summary = `${phase} · attempt ${attempt} · ${mode}`;
        const project = String(loop.workspace || "").split(/[/\\]/).filter(Boolean).pop() || "project";
        return `<div class="runtime-row loop-row">
          <span class="runtime-kind loop">LOOP</span>
          <span class="runtime-tool ${stateClass}" title="${esc(loop.id)}">${esc(project)} · ${esc(loop.goal || loop.id)}</span>
          <span class="runtime-summary" title="${esc(summary)}">${esc(summary)}</span>
          <span class="runtime-time">${age}</span>
        </div>`;
      }).join("")
    : '<div class="runtime-empty">No coding loops yet.</div>';

  const activeTransactions = transactions.filter((transaction) => transaction.status === "active");
  document.getElementById("dash-transaction-count").textContent = String(activeTransactions.length);
  const transactionsEl = document.getElementById("dash-transactions");
  transactionsEl.innerHTML = transactions.length
    ? transactions.slice(0, 8).map((transaction) => {
        const status = transaction.status || "unknown";
        const stateClass = status === "active" || status === "accepted" ? "runtime-state-ok" : "runtime-state-error";
        const verification = transaction.verification
          ? `verify ${transaction.verification.passed}/${transaction.verification.passed + transaction.verification.failed}`
          : "not verified";
        const updated = Date.parse(transaction.updated_at || "");
        const age = Number.isFinite(updated) ? `${formatElapsed(now - updated)} ago` : "—";
        const summary = `${transaction.files || 0} file(s), ${transaction.edits || 0} edit(s), ${verification}`;
        const project = String(transaction.workspace || "").split(/[/\\]/).filter(Boolean).pop() || "project";
        return `<div class="runtime-row transaction-row">
          <span class="runtime-kind transaction">${esc(status.toUpperCase().slice(0, 5))}</span>
          <span class="runtime-tool ${stateClass}" title="${esc(transaction.id)}">${esc(project)} · ${esc(transaction.label || transaction.id)}</span>
          <span class="runtime-summary" title="${esc(summary)}">${esc(summary)}</span>
          <span class="runtime-time">${age}</span>
        </div>`;
      }).join("")
    : '<div class="runtime-empty">No edit transactions yet.</div>';

  const capsules = Array.isArray(runtimeInfo.context_capsules) ? runtimeInfo.context_capsules : [];
  document.getElementById("dash-capsule-count").textContent = String(capsules.length);
  const capsulesEl = document.getElementById("dash-capsules");
  capsulesEl.innerHTML = capsules.length
    ? capsules.slice(0, 8).map((capsule) => {
        const source = capsule.last_checkpoint_source || "unknown";
        const stateClass = capsule.has_semantic_summary ? "runtime-state-ok" : "";
        const phase = capsule.loop_phase || capsule.loop_status || capsule.task_status || "saved";
        const updated = Date.parse(capsule.updated_at || "");
        const age = Number.isFinite(updated) ? `${formatElapsed(now - updated)} ago` : "?";
        const summary = `${source} · ${phase} · semantic ${capsule.has_semantic_summary ? "saved" : "pending"}`;
        return `<div class="runtime-row capsule-row">
          <span class="runtime-kind task">CTX</span>
          <span class="runtime-tool ${stateClass}" title="${esc(capsule.id)}">${esc(capsule.objective || capsule.id)}</span>
          <span class="runtime-summary" title="${esc(summary)}">${esc(summary)}</span>
          <span class="runtime-time">${age}</span>
        </div>`;
      }).join("")
    : '<div class="runtime-empty">No durable context capsule yet.</div>';

  const stateErrors = Array.isArray(runtimeInfo.state_errors) ? runtimeInfo.state_errors : [];
  const stateErrorsEl = document.getElementById("dash-state-errors");
  if (stateErrorsEl) {
    stateErrorsEl.hidden = stateErrors.length === 0;
    stateErrorsEl.innerHTML = stateErrors.length
      ? `<strong>Persistent state warning</strong><span>${esc(stateErrors.slice(0, 4).join(" · "))}${stateErrors.length > 4 ? ` · +${stateErrors.length - 4} more` : ""}</span>`
      : "";
  }
}

function serversTable(rows, { actions = true } = {}) {
  const controls = actions ? '<div class="btn-group" style="margin-bottom:12px"><button class="btn ghost" data-action="permissions">Permissions</button><button class="btn ghost" data-action="local-hooks">Local hooks</button><button class="btn ghost" data-action="subagents">Subagents</button><button class="btn ghost" data-action="codex-hooks">Codex hooks</button><button class="btn ghost" data-action="local-tools">Local tools</button></div>' : '';
  if (!rows.length) return controls + '<div class="empty">No upstream servers configured. Add one or import a configuration.</div>';
  const head = `<table><thead><tr>
    <th>Server</th><th>Transport</th><th>Status</th><th>Expose</th><th>Tools</th>
    ${actions ? "<th></th>" : ""}
  </tr></thead><tbody>`;
  const body = rows
    .map((s) => {
      const actionsCell = actions
        ? `<td><div class="btn-group">
            <button class="btn sm ghost" data-action="test" data-id="${esc(s.id)}">Test</button>
            <button class="btn sm ghost" data-action="tools" data-id="${esc(s.id)}">Tools</button>
            ${s.transport === "http" && s.auth === "oauth" ? `<button class="btn sm ghost" data-action="oauth" data-id="${esc(s.id)}">OAuth</button>` : ""}
            <button class="btn sm ghost" data-action="edit" data-id="${esc(s.id)}">Edit</button>
            <button class="btn sm ghost" data-action="delete" data-id="${esc(s.id)}">Delete</button>
          </div></td>`
        : "";
      return `<tr>
        <td><strong>${esc(s.name)}</strong><div class="muted" style="font-size:0.72rem;font-family:var(--mono)">${esc(s.id)}</div></td>
        <td>${esc(s.transport)}</td>
        <td>${badge(s.health)}</td>
        <td>${esc(s.expose)}</td>
        <td>${s.tool_count ?? 0} <span class="muted">/ ${s.proxied_tools?.length ?? 0} proxy</span></td>
        ${actionsCell}
      </tr>`;
    })
    .join("");
  return controls + head + body + "</tbody></table>";
}

async function loadDashboard() {
  const [health, runtimeInfo] = await Promise.all([api("/health"), api("/api/runtime")]);
  dashboardHealthCache = health;
  const transport = health.transport_mode === "sse"
    ? `SSE · ${Math.round((health.sse_keepalive_ms || 0) / 1000)}s`
    : "JSON";
  const activeTools = runtimeInfo.runtime?.active?.length ?? 0;
  const workers = [runtimeInfo.processes, runtimeInfo.ptys, runtimeInfo.subagents]
    .flatMap((items) => Array.isArray(items) ? items : [])
    .filter((item) => item.running).length;
  const policy = String(health.permission || "open").split(":", 1)[0];
  document.getElementById("conn-status").textContent = `MCP :${health.mcp_port} · ${transport} · ${health.active_sessions} sessions`;
  const instr = health.instructions || {};
  const memCount = instr.memory_files?.length ?? 0;
  const gitBranch = instr.git?.branch || (instr.git?.is_repo === false ? "—" : "?");
  const transports = Array.isArray(runtimeInfo.sessions) ? runtimeInfo.sessions : [];
  const activeWorkspaceRoots = new Set([
    ...(runtimeInfo.processes || []).filter((item) => item.running && item.project_root).map((item) => item.project_root),
    ...(runtimeInfo.agent_tasks || []).filter((item) => item.status === "active" || item.status === "blocked").map((item) => item.workspace),
    ...(runtimeInfo.coding_loops || []).filter((item) => item.status === "active").map((item) => item.workspace),
    ...(runtimeInfo.edit_transactions || []).filter((item) => item.status === "active").map((item) => item.workspace),
  ].filter(Boolean));
  const machineJobs = (runtimeInfo.processes || []).filter((item) => item.running && !item.project_root).length;
  const tunnel = runtimeInfo.tunnel || health.tunnel || {};
  document.getElementById("overview-transport").textContent = `${transport} · :${health.mcp_port}`;
  document.getElementById("stat-grid").innerHTML = `
    <div class="stat"><div class="stat-label">MCP Port</div><div class="stat-value">${health.mcp_port}</div></div>
    <div class="stat"><div class="stat-label">Transport</div><div class="stat-value">${esc(transport)}</div></div>
    <div class="stat"><div class="stat-label">MCP transports</div><div class="stat-value">${transports.length || health.active_sessions}</div></div>
    <div class="stat"><div class="stat-label">Active tools</div><div class="stat-value" id="stat-active-tools">${activeTools}</div></div>
    <div class="stat"><div class="stat-label">Workers</div><div class="stat-value" id="stat-workers">${workers}</div></div>
    <div class="stat"><div class="stat-label">Tool calls</div><div class="stat-value" id="stat-calls">${runtimeInfo.runtime?.total_calls ?? 0}</div></div>
    <div class="stat"><div class="stat-label">Errors</div><div class="stat-value" id="stat-errors">${runtimeInfo.runtime?.total_errors ?? 0}</div></div>
    <div class="stat"><div class="stat-label">Run ID</div><div class="stat-value" id="stat-run-id" style="font-size:0.85rem">${esc((runtimeInfo.identity?.run_id || "—").replace(/^run_/, "").slice(0, 12))}</div></div>
    <div class="stat"><div class="stat-label">Schema</div><div class="stat-value" id="stat-schema" style="font-size:0.85rem">v${esc(runtimeInfo.identity?.schema_contract_version ?? "?")} · ${esc((runtimeInfo.identity?.schema_hash || "—").slice(0, 8))}</div></div>
    <div class="stat"><div class="stat-label">Policy</div><div class="stat-value">${esc(policy)}</div></div>
    <div class="stat"><div class="stat-label">Tunnel</div><div class="stat-value" style="font-size:0.95rem">${esc(tunnelDisplay(tunnel).label)}</div>
      <div class="stat-sub">${esc(tunnelDisplay(tunnel).detail)}</div></div>
    <div class="stat"><div class="stat-label">Active workspaces</div><div class="stat-value">${activeWorkspaceRoots.size + (machineJobs ? 1 : 0)}</div>
      <div class="stat-sub">${activeWorkspaceRoots.size} project(s)${machineJobs ? ` · ${machineJobs} machine job(s)` : ""}</div></div>
    <div class="stat"><div class="stat-label">Project memory</div><div class="stat-value">${memCount} file(s)</div>
      <div class="stat-sub">${instr.instruction_bytes ? Math.round(instr.instruction_bytes / 1024) + " KB instructions" : ""}</div></div>
    <div class="stat"><div class="stat-label">Git branch</div><div class="stat-value" style="font-size:0.85rem">${esc(gitBranch)}</div></div>
    <div class="stat"><div class="stat-label">Server workspace</div><div class="stat-value" style="font-size:0.85rem">${esc(health.default_cwd?.split(/[/\\]/).pop())}</div>
      <div class="stat-sub">${esc(health.default_cwd)}</div></div>`;
  document.getElementById("dash-servers").innerHTML = serversTable(health.upstream || [], { actions: false });
  document.getElementById("status-json").textContent = JSON.stringify(health, null, 2);
  renderRuntimeOverview(runtimeInfo);
}

async function refreshDashboardRuntime() {
  if (dashboardRuntimeRefreshing || document.hidden || !document.getElementById("dashboard").classList.contains("active")) return;
  dashboardRuntimeRefreshing = true;
  try {
    const runtimeInfo = await api("/api/runtime");
    renderRuntimeOverview(runtimeInfo);
    if (dashboardHealthCache) {
      document.getElementById("conn-status").textContent =
        `MCP :${dashboardHealthCache.mcp_port} · ${dashboardHealthCache.transport_mode?.toUpperCase()} · ${dashboardHealthCache.active_sessions} sessions`;
    }
  } catch {
    const dot = document.getElementById("overview-dot");
    dot.className = "status-dot error";
    document.getElementById("overview-state").textContent = "Disconnected";
  } finally {
    dashboardRuntimeRefreshing = false;
  }
}

function startDashboardRuntimeLoop() {
  if (dashboardRuntimeTimer) return;
  dashboardRuntimeTimer = setInterval(() => refreshDashboardRuntime(), 5000);
}

function stopDashboardRuntimeLoop() {
  if (!dashboardRuntimeTimer) return;
  clearInterval(dashboardRuntimeTimer);
  dashboardRuntimeTimer = null;
}

async function loadProject() {
  const preview = await api("/api/instructions/preview");
  const s = preview.summary || {};
  document.getElementById("project-meta").innerHTML = `
    <div class="stat"><div class="stat-label">Root</div><div class="stat-value" style="font-size:0.8rem">${esc(s.root || "—")}</div></div>
    <div class="stat"><div class="stat-label">Memory files</div><div class="stat-value">${s.memory_files?.length ?? 0}</div></div>
    <div class="stat"><div class="stat-label">Instructions</div><div class="stat-value">${preview.total_chars ? Math.round(preview.total_chars / 1024) + " KB" : "—"}</div></div>
    <div class="stat"><div class="stat-label">Tool profile</div><div class="stat-value">${esc(s.tool_profile || "slim")}</div></div>
    <div class="stat"><div class="stat-label">Git</div><div class="stat-value">${esc(s.git?.branch || "—")}</div></div>`;
  document.getElementById("project-preview").textContent =
    preview.preview + (preview.truncated ? "\n\n… (truncated)" : "");
}

async function reviewProjectRecovery() {
  const projectField = document.getElementById("recovery-workspace");
  const workspace = projectField.value.trim();
  if (!workspace) {
    projectField.focus();
    throw new Error("Enter one project workspace before requesting a recovery review");
  }
  const hours = document.getElementById("recovery-stale-hours").value;
  const output = document.getElementById("recovery-review-results");
  const button = document.getElementById("recovery-review-btn");
  button.disabled = true;
  output.textContent = "Reading saved records in the selected workspace only…";
  try {
    const params = new URLSearchParams({ workspace, stale_hours: hours });
    const result = await api("/api/recovery/review?" + params.toString());
    const counts = result.counts || {};
    const groups = [
      ["Active or blocked plans", result.findings || [], "tasks"],
      ["Active coding loops", result.stale_loops || [], "coding_loops"],
      ["Active edit transactions", result.stale_transactions || [], "edit_transactions"],
    ];
    const renderEntry = (row, type) => {
      const identifier = row.id || "Unknown record";
      const label = type === "tasks" ? row.title || identifier : identifier;
      const info = [
        row.status,
        row.phase,
        Number.isFinite(row.age_hours) ? row.age_hours + "h old" : null,
        type === "tasks" && row.execution?.linked_loop
          ? "loop " + row.execution.linked_loop.status : null,
        type === "edit_transactions" ? (row.files || 0) + " files, " + (row.edits || 0) + " edits" : null,
        type === "coding_loops" && row.transaction_status ? "transaction " + row.transaction_status : null,
      ].filter(Boolean).join(" · ");
      const suggested = String(row.suggested_action || "inspect_manually").replaceAll("_", " ");
      return '<div class="recovery-entry">' +
        '<strong>' + esc(label) + '</strong>' +
        '<div class="muted">' + esc(identifier) + '</div>' +
        '<div class="muted">' + esc(info) + '</div>' +
        '<div class="muted">Suggested: ' + esc(suggested) + '</div>' +
        '</div>';
    };
    output.innerHTML = '<div class="recovery-summary">' +
      '<strong>' + esc(result.workspace || workspace) + '</strong>' +
      '<div class="muted">' + Number(counts.tasks || 0) + ' stale tasks · ' +
        Number(counts.coding_loops || 0) + ' stale loops · ' +
        Number(counts.edit_transactions || 0) + ' stale transactions</div>' +
      '<div class="muted">Read-only review. No records were modified.</div>' +
      '</div>' +
      groups.map(([heading, entries, type]) =>
        '<div class="recovery-group"><h3>' + esc(heading) + '</h3>' +
        (entries.length ? entries.map((row) => renderEntry(row, type)).join("") :
          '<div class="muted">No matching stale records.</div>') +
        (result.truncated?.[type] ? '<div class="muted">Additional results omitted by the review limit.</div>' : '') +
        '</div>'
      ).join("") +
      (result.source_limits?.potentially_incomplete
        ? '<div class="runtime-alert">Source scan limit reached. This review may be incomplete.</div>'
        : '');
  } catch (error) {
    output.textContent = "Recovery review failed: " + error.message;
    throw error;
  } finally {
    button.disabled = false;
  }
}

async function loadServers() {
  const health = await api("/health");
  const cfg = await api("/api/upstream");
  upstreamConfig = cfg.config;
  const el = document.getElementById("servers-table");
  el.innerHTML = serversTable(health.upstream || []);
  bindServerActions(el, cfg.config);
  await loadSkills().catch((err) => {
    document.getElementById("skills-table").textContent = err.message;
  });
}

async function loadSkills() {
  const scope = document.getElementById("skills-control-scope").value;
  const projectPath = document.getElementById("skills-project-path").value.trim();
  const params = new URLSearchParams({ scope });
  if (projectPath) params.set("path", projectPath);
  const result = await api("/api/skills?" + params.toString());
  const disabled = new Set(result.controls.disabled);
  const container = document.getElementById("skills-table");
  container.innerHTML = result.skills.length
    ? result.skills.map((skill) => {
      const inScopeEnabled = !disabled.has(skill.name);
      return `<label class="field checkbox"><input type="checkbox" data-skill-name="${esc(skill.name)}" ${inScopeEnabled ? "checked" : ""} />
        <span><strong>${esc(skill.name)}</strong> · ${esc(skill.source || "project")}
        ${skill.enabled ? "" : '<small class="muted"> (disabled)</small>'}
        <br /><small class="muted">${esc(skill.description || "")}</small></span></label>`;
    }).join("")
    : '<div class="empty">No project or global skills found.</div>';
  for (const checkbox of container.querySelectorAll("input[data-skill-name]")) {
    checkbox.addEventListener("change", async () => {
      checkbox.disabled = true;
      try {
        await api("/api/skills", {
          method: "PATCH",
          body: JSON.stringify({
            path: result.root, scope,
            name: checkbox.dataset.skillName,
            enabled: checkbox.checked,
          }),
        });
        await loadSkills();
        toast("Skill controls saved");
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        checkbox.disabled = false;
        toast(error.message, true);
      }
    });
  }
}

function bindServerActions(container, config) {
  container.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      try {
        if (action === "test") {
          const r = await api(`/api/upstream/${id}/test`, { method: "POST" });
          toast(r.ok ? `OK — ${r.status.tool_count} tools` : r.status.last_error || "Failed", !r.ok);
          await loadServers();
        } else if (action === "permissions") {
          await openConfigEditor("permissions");
        } else if (action === "local-hooks") {
          await openConfigEditor("local-hooks");
        } else if (action === "subagents") {
          await openConfigEditor("subagents");
        } else if (action === "codex-hooks") {
          const r = await api("/api/codex-hooks");
          document.getElementById("codex-hooks-list").innerHTML = r.hooks.length
            ? r.hooks.map((hook) => `<label class="field checkbox"><input type="checkbox" data-codex-hook="${esc(hook.id)}" ${hook.enabled ? "checked" : ""} ${hook.supported ? "" : "disabled"} /><span><strong>${esc(hook.plugin)}</strong> · ${esc(hook.event)}${hook.supported ? "" : " <small class=\"muted\">This event is not available through MCP</small>"}<br /><small class="muted">${esc(hook.command)}</small></span></label>`).join("")
            : '<div class="muted">No enabled Codex hooks were found.</div>';
          document.getElementById("codex-hooks-dialog").showModal();
        } else if (action === "oauth") {
          const r = await api(`/api/upstream/${id}/oauth/start`, { method: "POST", body: JSON.stringify({ reset: true }) });
          if (!r.status?.authorization_url) throw new Error("OAuth server did not return an authorization URL");
          window.open(r.status.authorization_url, "_blank", "noopener");
          toast(`OAuth started for ${id}`);
        } else if (action === "tools") {
          const r = await api(`/api/upstream/${id}/tools`);
          const list = document.getElementById("tools-list");
          list.innerHTML = r.tools.length
            ? r.tools.map((t) => `<div class="tool-row"><div class="name">${esc(t.name)}</div><div class="desc">${esc(t.description || "")}</div></div>`).join("")
            : '<div class="muted">No tools available</div>';
          document.getElementById("tools-dialog").showModal();
        } else if (action === "edit") {
          openServerDialog(config.servers.find((x) => x.id === id));
        } else if (action === "delete") {
          if (!confirm(`Delete server "${id}"?`)) return;
          await api(`/api/upstream/${id}`, { method: "DELETE" });
          toast("Deleted");
          await loadServers();
        }
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

async function loadImport() {
  const { sources } = await api("/api/import/sources");
  const grid = document.getElementById("import-grid");
  if (!sources.length) {
    grid.innerHTML = '<div class="empty">No MCP configuration files were found on this machine.</div>';
    return;
  }
  grid.innerHTML = sources
    .map(
      (s) => `<div class="import-card">
        <h3>${esc(SOURCE_LABELS[s.source] || s.source)}</h3>
        <div class="path">${esc(s.path)}</div>
        <div class="meta">${s.server_count} server(s)</div>
        <button class="btn primary sm" data-import="${esc(s.source)}" data-path="${esc(s.path)}">Import</button>
      </div>`
    )
    .join("");
  grid.querySelectorAll("[data-import]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const r = await api(`/api/import/${btn.dataset.import}`, {
          method: "POST",
          body: JSON.stringify({ path: btn.dataset.path, merge: true }),
        });
        toast(`Import OK: ${r.imported.join(", ") || "(no new servers)"}`);
        await refreshAll();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

// Absolute start/end timestamps in Europe/Berlin with the DST zone (CET/CEST)
// shown explicitly, independent of the server's local timezone. Missing or
// unparseable values render as a stable "Time unavailable" instead of leaking
// the raw input.
function formatBerlinTimestamp(iso) {
  if (iso === undefined || iso === null || iso === "") return "Time unavailable";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Time unavailable";
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(d);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", timeZoneName: "longOffset" })
    .formatToParts(d).find((p) => p.type === "timeZoneName")?.value || "";
  return `${date} ${/\+02/.test(offset) ? "CEST" : "CET"}`;
}

function activityKindBadge(kind) {
  const labels = { mcp: "MCP", tool: "TOOL", session: "SESSION", system: "SYS" };
  return `<span class="badge kind-${kind}">${labels[kind] || kind}</span>`;
}

function activityStatusBadge(status) {
  if (!status) return "";
  if (status === "ok") return '<span class="badge ok">ok</span>';
  if (status === "error" || status === "blocked") return `<span class="badge bad">${esc(status)}</span>`;
  return `<span class="badge">${esc(status)}</span>`;
}

const FRIENDLY_ACTION = {
  read_text_file: "Read file", write_file: "Wrote file", edit_file: "Edited source",
  multi_edit: "Edited multiple files", apply_patch: "Applied a patch",
  run_command: "Ran a command", run_commands_parallel: "Ran commands in parallel",
  start_process: "Started a background process", stop_process: "Stopped a process",
  process_status: "Checked a process", process_output: "Read process output",
  process_input: "Sent input to a process", glob: "Listed matching files",
  grep: "Searched the codebase", list_directory: "Listed a directory",
  git_status: "Checked Git status", git_diff: "Showed a Git diff",
  git_commit: "Created a Git commit", git_worktree: "Created a Git worktree",
  git_restore: "Restored a file", pty: "Opened an interactive terminal",
  subagent: "Delegated to a subagent", computer_observe: "Observed browser/desktop",
  computer_act: "Acted on browser/desktop", checkpoint: "Recorded a checkpoint",
  read_text_file_extra: "Read a file", search: "Searched",
};

function friendlyAction(tool, action) {
  const verb = FRIENDLY_ACTION[tool];
  if (verb) return verb;
  if (action === "initialize") return "Initialized MCP session";
  if (action === "tools/list") return "Discovered MCP tools";
  if (action === "tools/call") return `Called ${tool || "a tool"}`;
  return null;
}

// Deterministic glossary from action-glossary.js (pure static text — never
// embeds command text or arguments). Falls back to a safe "unknown" note.
// The effect badge also shows danger=true tools so mutating calls stand out.
function glossaryDetails(tool) {
  if (!window.ActionGlossary) return "";
  const g = window.ActionGlossary.describe(tool || "");
  const side = g.side;
  const danger = side.danger ? ' <span class="badge bad">side-effect</span>' : "";
  return `<div class="detail-row"><span class="detail-key">what</span><span class="detail-val">${esc(g.detail)}</span></div>` +
    `<div class="detail-row"><span class="detail-key">effect</span><span class="detail-val"><span class="badge side-${esc(side.key)}">${esc(side.label)}</span>${danger}</span></div>`;
}

// Guidance only for a recognized error classification; otherwise empty so the
// UI never supplies unverified advice. HTTP status is a transport/upstream
// signal, distinct from the tool's own effect.
function glossaryStatusNote(status, httpStatus) {
  if (!window.ActionGlossary) return "";
  const note = window.ActionGlossary.statusGuidance(status, httpStatus);
  if (!note) return "";
  return `<div class="detail-row"><span class="detail-key">note</span><span class="detail-val">${esc(note)}</span></div>`;
}

function accessModeLabel(policy) {
  if (policy === "open") return "Full / YOLO";
  if (policy === "workspace") return "Workspace";
  if (policy === "custom") return "Projects";
  if (policy === "read_only") return "Read-only";
  return policy || "unknown";
}

function renderActivityStatusBar(runtimeInfo, health) {
  const el = document.getElementById("activity-status-bar");
  if (!el) return;
  const permission = String(health?.permission || "open");
  const policy = permission.split(":", 1)[0];
  const roots = String(permission)
    .replace(/^open:/, "Unrestricted (open)")
    .replace(/^workspace:.*limited to/i, "limit")
    .replace(/^custom:.*roots=/i, "roots")
    .replace(/^read_only:.*limited to/i, "limit");
  const online = Boolean(health && (health.permission || health.authMode));
  const sessions = health?.active_sessions ?? runtimeInfo?.sessions?.length ?? 0;
  const processes = Array.isArray(runtimeInfo?.processes) ? runtimeInfo.processes : [];
  const jobs = processes.filter((item) => item.running).length;
  const latest = lastRuntimeActivityMs(runtimeInfo?.runtime || {});
  const now = Date.now();
  const lastTool = latest == null ? "—" : `${formatElapsed(now - latest)} ago`;
  const tunnel = runtimeInfo?.tunnel || health?.tunnel || {};
  const rootsText = policy === "open"
    ? "Unrestricted (open)"
    : String(runtimeInfo?.identity
        ? (permission.match(/roots=([^;]*)/) || [])[1] || permission : permission);
  const chips = [
    { cls: online ? "ok" : "off", text: online ? "MCP online" : "MCP offline" },
    { cls: "", text: `Mode · ${accessModeLabel(policy)}` },
    { cls: "", text: `Roots · ${rootsText}` },
    { cls: "", text: `Sessions · ${sessions}` },
    { cls: jobs ? "busy" : "", text: `Jobs · ${jobs}` },
    { cls: "", text: `Last tool · ${lastTool}` },
    { cls: tunnelDisplay(tunnel).healthy ? "ok" : "", text: `Tunnel · ${tunnelDisplay(tunnel).label}${tunnel.management === "launchd" ? " (launchd)" : ""}` },
  ];
  el.innerHTML = chips
    .map((c) => `<span class="status-chip ${c.cls}">${esc(c.text)}</span>`)
    .join("");
}

function renderActivityRunning(runtime) {
  const el = document.getElementById("activity-running");
  const count = document.getElementById("activity-running-count");
  if (!el) return;
  const active = Array.isArray(runtime?.active) ? runtime.active : [];
  if (count) count.textContent = String(active.length);
  const now = Date.now();
  el.innerHTML = active.length
    ? active.map((item) => {
        const verb = friendlyAction(item.tool, null) || "Running tool";
        const project = String(item.project_root || "").split(/[/\\]/).filter(Boolean).pop() || "";
        return `<div class="runtime-row activity-running-row">
          ${runtimeKind(item.kind)}
          <span class="runtime-tool" title="${esc(item.tool)}">${esc(verb)} · ${esc(item.tool)}</span>
          <span class="runtime-summary" title="${esc(item.summary)}">${esc(item.summary || "processing")}${project ? ` <span class="muted">(${esc(project)})</span>` : ""}</span>
          <span class="runtime-time">${formatElapsed(now - item.started_ms)}</span>
        </div>`;
      }).join("")
    : '<div class="runtime-empty">No tool calls currently running.</div>';
}

function renderActivityLiveState(state, detail) {
  const el = document.getElementById("activity-live-state");
  if (!el) return;
  if (!state) {
    el.hidden = true;
    el.textContent = "";
    el.className = "activity-live-state";
    return;
  }
  el.hidden = false;
  el.textContent = detail || "";
  el.className = state === "off" ? "activity-live-state off" : "activity-live-state";
}

function renderActivityDetails(entry) {
  const d = entry.details || {};
  const safeArgs = d.arguments && typeof d.arguments === "object" && Object.keys(d.arguments).length
    ? Object.entries(d.arguments).map(([k, v]) => `<div class="detail-row"><span class="detail-key">${esc(k)}</span><span class="detail-val">${esc(JSON.stringify(v))}</span></div>`).join("")
    : "";
  const http = d.http_status != null ? `<div class="detail-row"><span class="detail-key">http</span><span class="detail-val">${d.http_status}</span></div>` : "";
  const error = entry.status === "error" || entry.status === "blocked"
    ? `<div class="detail-row"><span class="detail-key">error</span><span class="detail-val">${esc(entry.summary || d.error || "failed")}</span></div>` : "";
  // end = start + duration; only meaningful when both a parseable start and a duration exist.
  const startMs = Date.parse(entry.time);
  const end = (Number.isFinite(startMs) && entry.duration_ms != null)
    ? formatBerlinTimestamp(new Date(startMs + entry.duration_ms).toISOString())
    : "";
  const meta = `<div class="detail-row"><span class="detail-key">start</span><span class="detail-val">${esc(formatBerlinTimestamp(entry.time))}</span></div>` +
    (end ? `<div class="detail-row"><span class="detail-key">end</span><span class="detail-val">${esc(end)}</span></div>` : "") +
    (entry.session_id ? `<div class="detail-row"><span class="detail-key">session</span><span class="detail-val">${esc(entry.session_id)}</span></div>` : "") +
    (entry.duration_ms != null ? `<div class="detail-row"><span class="detail-key">duration</span><span class="detail-val">${entry.duration_ms}ms</span></div>` : "");
  const toolName = entry.tool || entry.action || "";
  const httpStatus = d.http_status != null ? Number(d.http_status) : null;
  return `<div class="activity-details hidden">
    ${glossaryDetails(toolName)}
    ${meta}${error}${http}${glossaryStatusNote(entry.status, httpStatus)}
    ${safeArgs ? '<div class="detail-section">sanitized arguments</div>' + safeArgs : ""}
  </div>`;
}

// Expandable Overview row: sanitized technical details are already redacted
// server-side (summary/error go through redactSecretsInText), so they are safe
// to surface here. The row is a native <button> disclosure (aria-expanded /
// aria-controls) so it is keyboard-operable; the whole row also toggles via a
// single delegated click handler (see bindRecentToggle) for mouse users.
function renderRecentRow(item) {
  const stateClass = item.status === "ok" ? "runtime-state-ok" : "runtime-state-error";
  const summary = item.status === "error" ? (item.error || item.summary) : item.summary;
  const open = recentExpanded.has(item.id);
  const detailsId = `recent-details-${recentDetailsSeq++}`;
  const detailsCls = open ? "activity-details" : "activity-details hidden";
  const details = `<div id="${detailsId}" class="${detailsCls}">
    ${glossaryDetails(item.tool)}${glossaryStatusNote(item.status, null)}
    <div class="detail-row"><span class="detail-key">start</span><span class="detail-val">${esc(formatBerlinTimestamp(item.started_at))}</span></div>
    <div class="detail-row"><span class="detail-key">end</span><span class="detail-val">${esc(formatBerlinTimestamp(item.finished_at))}</span></div>
    <div class="detail-row"><span class="detail-key">duration</span><span class="detail-val">${esc(formatElapsed(item.duration_ms))}</span></div>
    <div class="detail-row"><span class="detail-key">result</span><span class="detail-val">${esc(formatBytes(item.result_bytes))}</span></div>
    ${item.repeated ? '<div class="detail-row"><span class="detail-key">repeated</span><span class="detail-val">yes</span></div>' : ""}
    ${item.session_id ? `<div class="detail-row"><span class="detail-key">session</span><span class="detail-val">${esc(item.session_id)}</span></div>` : ""}
    ${item.project_root ? `<div class="detail-row"><span class="detail-key">project</span><span class="detail-val">${esc(item.project_root)}</span></div>` : ""}
    ${item.workspace_kind ? `<div class="detail-row"><span class="detail-key">workspace</span><span class="detail-val">${esc(item.workspace_kind)}</span></div>` : ""}
    ${item.status === "error" ? `<div class="detail-row"><span class="detail-key">error</span><span class="detail-val">${esc(item.error || item.summary)}</span></div>` : ""}
    ${item.summary ? `<div class="detail-row"><span class="detail-key">summary</span><span class="detail-val">${esc(item.summary)}</span></div>` : ""}
  </div>`;
  return `<div class="runtime-row recent-row" data-recent-id="${esc(item.id)}">
    ${runtimeKind(item.kind)}
    <span class="runtime-tool ${stateClass}" title="${esc(item.tool)}">${esc(item.tool)}</span>
    <span class="runtime-summary" title="${esc(summary)}">${esc(summary || item.status)}</span>
    <span class="runtime-time">${esc(formatElapsed(item.duration_ms))}</span>
    <button type="button" class="recent-toggle" aria-expanded="${open ? "true" : "false"}" aria-controls="${detailsId}" aria-label="Toggle details for ${esc(item.tool)}">${open ? "−" : "+"}</button>
    ${details}
  </div>`;
}

// One delegated click handler on the persistent #dash-recent container toggles
// any Overview row (handles many rows without per-row listeners that would be
// rebuilt on every 5s render). Clicking anywhere on the row toggles it.
function bindRecentToggle(container) {
  container.addEventListener("click", (event) => {
    const row = event.target.closest(".recent-row");
    if (!row) return;
    const id = row.getAttribute("data-recent-id");
    const details = row.querySelector(".activity-details");
    const toggle = row.querySelector(".recent-toggle");
    if (!details || !toggle) return;
    const nowOpen = !details.classList.contains("hidden");
    details.classList.toggle("hidden");
    toggle.setAttribute("aria-expanded", String(!nowOpen));
    if (id) {
      if (nowOpen) recentExpanded.delete(id);
      else recentExpanded.add(id);
    }
  });
}

function renderActivityRow(entry) {
  const tool = entry.tool || entry.action || "—";
  const verb = friendlyAction(entry.tool, entry.action) || friendlyAction(tool, null) || tool;
  const summary = entry.summary || entry.target || "";
  const dur = entry.duration_ms != null ? `${entry.duration_ms}ms` : "";
  const sid = entry.session_id ? entry.session_id.slice(0, 8) : "";
  return `<div class="activity-row" data-id="${esc(entry.id)}">
    <div class="activity-main">
      <span class="activity-time">${formatTime(entry.time)}</span>
      ${activityKindBadge(entry.kind)}
      <span class="activity-tool" title="${esc(tool)}">${esc(tool)}</span>
      ${activityStatusBadge(entry.status)}
      ${dur ? `<span class="activity-dur">${dur}</span>` : ""}
      ${sid ? `<span class="activity-sid" title="${esc(entry.session_id)}">${esc(sid)}</span>` : ""}
    </div>
    <div class="activity-description"><strong>${esc(verb)}</strong>${summary ? ` <span class="muted">— ${esc(summary)}</span>` : ""}</div>
    ${renderActivityDetails(entry)}
  </div>`;
}

function bindActivityRows(container) {
  container.querySelectorAll(".activity-row").forEach((row) => {
    const details = row.querySelector(".activity-details");
    if (!details) return;
    row.addEventListener("click", () => details.classList.toggle("hidden"));
  });
}

function mergeActivityEntries(entries, { prepend = false } = {}) {
  const feed = document.getElementById("activity-feed");
  const empty = feed.querySelector(".empty");
  if (empty) empty.remove();

  const fresh = entries.filter((e) => !activitySeenIds.has(e.id));
  if (!fresh.length) return;

  for (const e of fresh) activitySeenIds.add(e.id);
  const html = fresh.map(renderActivityRow).join("");

  if (prepend) {
    feed.insertAdjacentHTML("afterbegin", html);
    bindActivityRows(feed);
    while (feed.children.length > 300) feed.lastElementChild?.remove();
    return;
  }

  feed.innerHTML = html + feed.innerHTML;
  bindActivityRows(feed);
  while (feed.children.length > 300) feed.lastElementChild?.remove();
}

async function loadActivity({ reset = false } = {}) {
  if (activityPaused && !reset) return;
  const kind = document.getElementById("activity-kind").value;
  const status = document.getElementById("activity-status").value;
  const q = document.getElementById("activity-search").value.trim();
  const params = new URLSearchParams({ limit: "120" });
  if (kind !== "all") params.set("kind", kind);
  if (status === "error") params.set("status", "error");
  if (q) params.set("q", q);

  const { entries } = await api(`/api/activity?${params}`);
  if (reset) {
    activitySeenIds.clear();
    const feed = document.getElementById("activity-feed");
    feed.innerHTML = entries.length
      ? entries.map(renderActivityRow).join("")
      : '<div class="empty">No activity matches the current filters.</div>';
    activitySeenIds = new Set(entries.map((e) => e.id));
    bindActivityRows(feed);
    return;
  }
  mergeActivityEntries(entries, { prepend: true });
}

function activityTabVisible() {
  return !document.hidden && Boolean(document.getElementById("activity")?.classList.contains("active"));
}

function activityStreamWanted() {
  return activityTabVisible() && document.getElementById("activity-live").checked &&
    !activityPaused && !document.getElementById("admin-login")?.open;
}

function stopActivityStream() {
  if (activityPollTimer) {
    clearInterval(activityPollTimer);
    activityPollTimer = null;
  }
  if (activityReconnectTimer) {
    clearTimeout(activityReconnectTimer);
    activityReconnectTimer = null;
  }
  activityReconnectAttempt = 0;
  if (activityEventSource) {
    activityEventSource.close();
    activityEventSource = null;
  }
}

function scheduleActivityReconnect() {
  if (activityReconnectTimer || !activityStreamWanted()) return;
  const delay = Math.min(30000, 2000 * (2 ** Math.min(activityReconnectAttempt++, 4)));
  activityReconnectTimer = setTimeout(() => {
    activityReconnectTimer = null;
    startActivityStream();
  }, delay);
}

function startActivityStream({ restart = false } = {}) {
  if (!activityStreamWanted()) return;
  if (activityEventSource && !restart) return;
  activityEventSource?.close();
  if (activityReconnectTimer) {
    clearTimeout(activityReconnectTimer);
    activityReconnectTimer = null;
  }
  const source = new EventSource("/api/activity/stream");
  activityEventSource = source;
  source.onopen = () => {
    if (activityEventSource !== source) return;
    activityReconnectAttempt = 0;
    renderActivityLiveState(null);
    if (activityPollTimer) {
      clearInterval(activityPollTimer);
      activityPollTimer = null;
    }
    // Backfill activity missed while the browser or laptop was asleep.
    loadActivity().catch(() => {});
  };
  source.onmessage = (ev) => {
    if (activityEventSource !== source) return;
    try {
      const entry = JSON.parse(ev.data);
      const kind = document.getElementById("activity-kind").value;
      const status = document.getElementById("activity-status").value;
      const q = document.getElementById("activity-search").value.trim().toLowerCase();
      if (kind !== "all" && entry.kind !== kind) return;
      if (status === "error" && entry.status !== "error" && entry.status !== "blocked") return;
      if (q) {
        const hay = [entry.tool, entry.action, entry.target, entry.summary].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return;
      }
      mergeActivityEntries([entry], { prepend: true });
    } catch {}
  };
  source.onerror = () => {
    if (activityEventSource !== source) return;
    source.close();
    activityEventSource = null;
    if (!activityStreamWanted()) return;
    if (!activityPollTimer) {
      activityPollTimer = setInterval(() => {
        if (activityTabVisible()) loadActivity().catch(() => {});
      }, 2000);
    }
    scheduleActivityReconnect();
    renderActivityLiveState("off", "Live stream disconnected — polling while reconnecting…");
  };
}

async function refreshActivityContext() {
  if (activityContextRefreshing) return;
  activityContextRefreshing = true;
  try {
    const signal = AbortSignal.timeout(10000);
    const [health, runtimeInfo] = await Promise.all([
      api("/health", { signal }), api("/api/runtime", { signal }),
    ]);
    if (!activityTabVisible()) return;
    renderActivityStatusBar(runtimeInfo, health);
    renderActivityRunning(runtimeInfo.runtime || {});
    dashboardHealthCache = health;
    if (!activityStreamWanted() || activityEventSource?.readyState === EventSource.OPEN) {
      renderActivityLiveState(null);
    } else if (activityPollTimer) {
      renderActivityLiveState("off", "Live stream disconnected — polling while reconnecting…");
    }
  } catch (error) {
    if (activityTabVisible()) {
      renderActivityLiveState("off", error.status === 401
        ? "Admin session expired — sign in to reconnect."
        : "Connection to the Admin API lost — retrying…");
    }
  } finally {
    activityContextRefreshing = false;
  }
}

let activityContextTimer = null;
function stopActivityContextLoop() {
  if (activityContextTimer) { clearInterval(activityContextTimer); activityContextTimer = null; }
}
function startActivityContextLoop() {
  if (activityContextTimer) return;
  activityContextLastTick = Date.now();
  activityContextTimer = setInterval(() => {
    const now = Date.now();
    const wokeFromSleep = now - activityContextLastTick > 15000;
    activityContextLastTick = now;
    if (!activityTabVisible()) return;
    if (wokeFromSleep) return resumeAdminUiAfterWake();
    refreshActivityContext().catch(() => {});
  }, 3000);
}

function onActivityTabActive() {
  loadActivity({ reset: true }).catch((e) => toast(e.message, true));
  refreshActivityContext().catch(() => {});
  startActivityContextLoop();
  startActivityStream();
}

function resumeAdminUiAfterWake() {
  if (document.hidden) return;
  if (activityTabVisible()) {
    loadActivity().catch(() => {});
    refreshActivityContext().catch(() => {});
    if (activityStreamWanted()) {
      activityReconnectAttempt = 0;
      startActivityStream({ restart: true });
    }
  } else if (document.getElementById("dashboard")?.classList.contains("active")) {
    refreshDashboardRuntime().catch(() => {});
  } else if (document.getElementById("missions")?.classList.contains("active")) {
    loadMissions().catch(() => {});
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopActivityStream();
  else resumeAdminUiAfterWake();
});
window.addEventListener("online", resumeAdminUiAfterWake);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) resumeAdminUiAfterWake();
});

async function loadEnvForm() {
  const data = await api("/api/config/env");
  const form = document.getElementById("env-form");
  form.innerHTML = "";
  const values = data.values || {};
  const secretKeys = new Set(data.redacted_keys || []);
  for (const key of ENV_KEYS) {
    const label = document.createElement("label");
    label.innerHTML = `<span>${key}</span>`;
    const input = document.createElement("input");
    input.name = key;
    input.value = values[key] ?? "";
    if (secretKeys.has(key)) {
      input.type = "password";
      input.autocomplete = "new-password";
      input.placeholder = "Saved secret — leave blank to keep";
    }
    label.appendChild(input);
    form.appendChild(label);
  }
}

const dialog = document.getElementById("server-dialog");
const serverForm = document.getElementById("server-form");

function transportFields(form) {
  const t = form.transport.value;
  form.querySelectorAll(".stdio-field").forEach((el) => el.classList.toggle("hidden", t !== "stdio"));
  form.querySelectorAll(".http-field").forEach((el) => el.classList.toggle("hidden", t !== "http"));
}

serverForm.transport.addEventListener("change", () => transportFields(serverForm));

function openServerDialog(server) {
  editingServerId = server?.id ?? null;
  serverForm.reset();
  document.getElementById("dialog-title").textContent = server ? "Edit MCP Server" : "Add MCP Server";
  if (server) {
    serverForm.id.value = server.id;
    serverForm.id.readOnly = true;
    serverForm.name.value = server.name || "";
    serverForm.enabled.checked = server.enabled !== false;
    serverForm.transport.value = server.transport;
    serverForm.command.value = server.command || "";
    serverForm.args.value = JSON.stringify(server.args || []);
    serverForm.cwd.value = server.cwd || "";
    serverForm.url.value = server.url || "";
    serverForm.auth_type.value = server.auth?.type || (server.transport === "http" ? "auto" : "none");
    serverForm.oauth_scope.value = server.auth?.scope || "";
    serverForm.bearer_token_env_var.value = server.bearer_token_env_var || "";
    serverForm.headers.value = JSON.stringify(server.headers || {});
    serverForm.tool_prefix.value = server.tool_prefix || server.id;
    serverForm.expose.value = server.expose || "all";
    serverForm.tools.value = (server.tools || []).join(", ");
    serverForm.idle_timeout_sec.value = server.idle_timeout_sec ?? 600;
  } else {
    serverForm.id.readOnly = false;
  }
  transportFields(serverForm);
  dialog.showModal();
}

document.getElementById("close-dialog").addEventListener("click", () => dialog.close());
document.getElementById("close-tools").addEventListener("click", () => document.getElementById("tools-dialog").close());

serverForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  let args = [];
  let headers = {};
  try {
    args = serverForm.args.value.trim() ? JSON.parse(serverForm.args.value) : [];
  } catch {
    return toast("Args must be a valid JSON array", true);
  }
  try {
    headers = serverForm.headers.value.trim() ? JSON.parse(serverForm.headers.value) : {};
    if (!headers || Array.isArray(headers)) throw new Error();
  } catch {
    return toast("Headers must be a valid JSON object", true);
  }
  const server = {
    id: serverForm.id.value.trim(),
    name: serverForm.name.value.trim() || serverForm.id.value.trim(),
    enabled: serverForm.enabled.checked,
    transport: serverForm.transport.value,
    command: serverForm.command.value.trim() || undefined,
    args,
    cwd: serverForm.cwd.value.trim() || undefined,
    url: serverForm.url.value.trim() || undefined,
    headers: Object.keys(headers).length ? headers : undefined,
    bearer_token_env_var: serverForm.bearer_token_env_var.value.trim() || undefined,
    auth: serverForm.transport.value === "http" ? {
      type: serverForm.auth_type.value || "auto",
      ...(serverForm.oauth_scope.value.trim() ? { scope: serverForm.oauth_scope.value.trim() } : {}),
    } : { type: "none" },
    tool_prefix: serverForm.tool_prefix.value.trim() || undefined,
    expose: serverForm.expose.value,
    tools: serverForm.tools.value.split(",").map((name) => name.trim()).filter(Boolean),
    idle_timeout_sec: Number(serverForm.idle_timeout_sec.value) || 600,
  };
  try {
    await api("/api/upstream", { method: "POST", body: JSON.stringify({ server }) });
    dialog.close();
    toast("Saved");
    await loadServers();
  } catch (err) {
    toast(err.message, true);
  }
});

const CONFIG_EDITORS = {
  permissions: { endpoint: "/api/permissions", dialog: "permissions-dialog", editor: "permissions-json" },
  "local-hooks": { endpoint: "/api/hooks", dialog: "local-hooks-dialog", editor: "local-hooks-json" },
  subagents: { endpoint: "/api/subagents", dialog: "subagents-dialog", editor: "subagents-json" },
};

async function openConfigEditor(kind) {
  const meta = CONFIG_EDITORS[kind];
  const data = await api(meta.endpoint);
  document.getElementById(meta.editor).value = JSON.stringify(data.config || {}, null, 2);
  if (kind === "subagents") {
    const keys = data.env_keys || [];
    document.getElementById("subagents-env-keys").textContent = keys.length
      ? `Configured environment keys (values hidden): ${keys.join(", ")}`
      : "No subagent environment keys are configured.";
  }
  document.getElementById(meta.dialog).showModal();
}

async function saveConfigEditor(kind) {
  const meta = CONFIG_EDITORS[kind];
  let config;
  try {
    config = JSON.parse(document.getElementById(meta.editor).value || "{}");
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
  const result = await api(meta.endpoint, { method: "PUT", body: JSON.stringify({ config }) });
  document.getElementById(meta.dialog).close();
  toast(`Saved ${kind}.`);
  return result;
}

for (const [kind, meta] of Object.entries(CONFIG_EDITORS)) {
  const closeId = `close-${kind}`;
  const saveId = `save-${kind}`;
  document.getElementById(closeId).addEventListener("click", () => document.getElementById(meta.dialog).close());
  document.getElementById(saveId).addEventListener("click", () => {
    saveConfigEditor(kind).catch((error) => toast(error.message, true));
  });
}

document.getElementById("close-codex-hooks").addEventListener("click", () => document.getElementById("codex-hooks-dialog").close());
document.getElementById("save-codex-hooks").addEventListener("click", async () => {
  const enabled = [...document.querySelectorAll("[data-codex-hook]:checked")].map((input) => input.dataset.codexHook);
  await api("/api/codex-hooks", { method: "PUT", body: JSON.stringify({ enabled }) });
  document.getElementById("codex-hooks-dialog").close();
  toast("Saved. SessionStart hook changes apply to new MCP chats.");
});

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
    document.getElementById("page-title").textContent = TITLES[btn.dataset.tab] || btn.dataset.tab;
    stopActivityStream();
    stopDashboardRuntimeLoop();
    stopActivityContextLoop();
    stopMissionsLoop();
    if (btn.dataset.tab === "dashboard") {
      refreshDashboardRuntime();
      startDashboardRuntimeLoop();
    }
    if (btn.dataset.tab === "activity") onActivityTabActive();
    if (btn.dataset.tab === "missions") {
      loadMissions().catch((e) => toast(e.message, true));
      startMissionsLoop();
    }
    if (btn.dataset.tab === "project") loadProject().catch((e) => toast(e.message, true));
  });
});

document.getElementById("activity-kind").addEventListener("change", () => loadActivity({ reset: true }).catch((e) => toast(e.message, true)));
document.getElementById("activity-status").addEventListener("change", () => loadActivity({ reset: true }).catch((e) => toast(e.message, true)));
document.getElementById("activity-search").addEventListener("input", () => {
  clearTimeout(activitySearchDebounce);
  activitySearchDebounce = setTimeout(() => loadActivity({ reset: true }).catch(() => {}), 350);
});
let activitySearchDebounce;
document.getElementById("activity-live").addEventListener("change", () => {
  activityPaused = false;
  if (document.getElementById("activity-live").checked) startActivityStream();
  else {
    stopActivityStream();
    renderActivityLiveState(null);
  }
});
document.getElementById("activity-clear").addEventListener("click", () => {
  activitySeenIds.clear();
  document.getElementById("activity-feed").innerHTML =
    '<div class="empty">View cleared. New activity will still appear while Live is enabled.</div>';
});

let missionsTimer = null;
function stopMissionsLoop() {
  if (missionsTimer) { clearInterval(missionsTimer); missionsTimer = null; }
}
function startMissionsLoop() {
  if (missionsTimer) return;
  missionsTimer = setInterval(() => loadMissions().catch(() => {}), 5000);
}

function missionHandoffPrompt(task) {
  return `Attach @Local ChatGPT Plus and resume mission ${task.id}.\n\n` +
    `Repository: ${task.workspace}\n` +
    `Goal: ${task.title}\n` +
    `Objective: ${task.objective || ""}\n\n` +
    `Use the \`agent_task\` tool (action=list/read/update) with id ${task.id} to read the ` +
    `current plan, continue the work within ${task.workspace}, and record explicit step ` +
    `results/notes. Do not mutate files outside that workspace.`;
}

function missionCard(task, now) {
  const progress = task.progress || {};
  const step = progress.current_step || progress.next_step;
  const project = String(task.workspace || "").split(/[/\\]/).filter(Boolean).pop() || "project";
  const updated = Date.parse(task.updated_at || "");
  const age = Number.isFinite(updated) ? `${formatElapsed(now - updated)} ago` : "—";
  const executionState = task.execution?.state || "waiting";
  const blocked = ["blocked", "stalled"].includes(executionState) || progress.current_step?.status === "blocked";
  const warning = task.execution?.warnings?.[0] || "";
  const hasChecklist = Array.isArray(task.plan) || (task.steps?.length ?? 0) > 0;
  const percent = Number(progress.percent ?? 0);
  return `<div class="mission-card ${blocked ? "blocked" : ""}">
    <div class="mission-head">
      <span class="badge ${blocked ? "bad" : "ok"}" title="${esc(task.execution?.reason || "Saved plan")}">${esc(executionState)}</span>
      <span class="mission-project">${esc(project)}</span>
      <span class="mission-id">${esc(task.id)}</span>
    </div>
    <div class="mission-goal"><strong>${esc(task.title)}</strong></div>
    <div class="mission-objective">${esc(task.objective || "")}</div>
    <div class="mission-meta">
      <span>Source · <strong>ChatGPT · saved plan</strong></span>
      <span>Last plan update · ${age}</span>
      <span>Linked live workers · ${Number(task.execution?.running_worker_count ?? 0)}</span>
      ${hasChecklist ? `<span>Progress · <strong>${percent}%</strong></span>` : ""}
    </div>
    <div class="mission-step">${step ? `Current step · <strong>${esc(step.title || "")}</strong>` : (task.status === "active" ? "Not started" : "—")}</div>
    ${blocked ? `<div class="mission-action">${esc(task.execution?.reason || "Action required · inspect and resume the saved plan")}</div>` : ""}
    ${warning ? `<div class="mission-action">${esc(warning)}</div>` : ""}
    <menu class="mission-actions">
      <button type="button" class="btn ghost sm" data-handoff="${esc(task.id)}">Copy handoff instructions</button>
    </menu>
  </div>`;
}

const TERMINAL_WORKER = new Set(["completed", "failed", "cancelled", "interrupted"]);
function renderWorkersList(workers) {
  const el = document.getElementById("workers-list");
  const count = document.getElementById("workers-count");
  const list = Array.isArray(workers) ? workers : [];
  if (count) count.textContent = String(list.length);
  const now = Date.now();
  el.innerHTML = list.length
    ? list.map((w) => {
        const started = Date.parse(w.started_at || "");
        const age = Number.isFinite(started) ? formatElapsed(now - started) : "—";
        const sourceBadge = w.source === "omp-subagent"
          ? '<span class="badge">OMP</span>'
          : `<span class="badge">${esc(String(w.source || "worker"))}</span>`;
        const statusCls = w.status === "cancelled" || w.status === "failed" || w.status === "interrupted"
          ? "runtime-state-error"
          : w.status === "completed" ? "runtime-state-ok" : "";
        const project = String(w.workspace || "").split(/[/\\]/).filter(Boolean).pop() || "";
        const modelTag = w.model ? `<span class="muted"> · ${esc(String(w.model))}</span>` : "";
        const cancelBtn = TERMINAL_WORKER.has(w.status)
          ? ""
          : `<button type="button" class="btn sm ghost" data-cancel-worker="${esc(w.id)}">Cancel</button>`;
        return `<div class="runtime-row worker-row">
          ${sourceBadge}
          <span class="runtime-tool ${statusCls}" title="${esc(w.id)}">${esc(String(w.kind))} · ${esc(String(w.status))}</span>
          <span class="runtime-summary" title="${esc(String(w.objective || ""))}">${esc(String(w.objective || w.id))}${project ? ` <span class="muted">(${esc(project)})</span>` : ""}${modelTag}</span>
          <span class="runtime-time">${age}</span>
          <span class="runtime-time">${cancelBtn}</span>
        </div>`;
      }).join("")
    : '<div class="runtime-empty">No independently-running owned workers. ChatGPT-direct calls are not separate workers.</div>';
  el.querySelectorAll("[data-cancel-worker]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api(`/api/workers/${encodeURIComponent(btn.dataset.cancelWorker)}/cancel`, { method: "POST" });
        toast("Worker cancelled");
        await loadMissions();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

function renderReadinessPanel(readiness) {
  const el = document.getElementById("readiness-panel");
  if (!el) return;
  if (!readiness) {
    el.innerHTML = '<div class="runtime-empty">Delegation readiness requires the current build after a server restart.</div>';
    return;
  }
  const s = readiness.subagent || {};
  const c = readiness.computer_use || {};
  const subagentState = s.enabled ? "enabled" : "not configured";
  const subagentCls = s.enabled ? "runtime-state-ok" : "runtime-state-error";
  const cuState = c.enabled_provider_count > 0 ? "provider enabled" : "blocked";
  const cuCls = c.enabled_provider_count > 0 && c.unsafe_runtimes_allowed ? "runtime-state-ok" : "runtime-state-error";
  const rows = [
    `<div class="runtime-row">
      <span class="runtime-kind task">SUBAGENT</span>
      <span class="runtime-tool ${subagentCls}">${esc(subagentState)}${s.model ? ` · ${esc(String(s.model))}` : ""}</span>
      <span class="runtime-summary" title="${esc(s.hint || "")}">${esc(s.hint || "Not configured.")}</span>
      <span class="runtime-time">${s.enabled ? `${esc(String(s.max_concurrency))} max` : "—"}</span>
    </div>`,
    `<div class="runtime-row">
      <span class="runtime-kind read">COMPUTER</span>
      <span class="runtime-tool ${cuCls}">${esc(cuState)} · ${c.providers?.length ?? 0} provider(s)</span>
      <span class="runtime-summary" title="${esc(c.hint || "")}">${esc(c.hint || "Not available.")}</span>
      <span class="runtime-time">scope ${esc(String(c.scope_grant_verified || "external"))}</span>
    </div>`,
  ];
  el.innerHTML = rows.join("");
}

async function loadMissions() {
  if (document.hidden || !document.getElementById("missions")?.classList.contains("active")) return;
  const runtimeInfo = await api("/api/runtime");
  const tasks = Array.isArray(runtimeInfo.agent_tasks) ? runtimeInfo.agent_tasks : [];
  const now = Date.now();
  const resumable = tasks.filter((t) => t.status === "active" || t.status === "blocked");
  const board = document.getElementById("missions-board");
  const attention = document.getElementById("missions-attention");
  const statusBar = document.getElementById("missions-status-bar");
  document.getElementById("missions-count").textContent = String(resumable.length);
  if (statusBar) {
    statusBar.innerHTML =
      '<span class="status-chip">Persistent agent-task registry</span>' +
      `<span class="status-chip">${resumable.length} active</span>` +
      '<span class="status-chip">Cross-conversation handoff supported via the same MCP plugin</span>';
  }
  board.innerHTML = resumable.length
    ? resumable.map((t) => missionCard(t, now)).join("")
    : '<div class="empty">No active missions. Ask ChatGPT to start a persistent agent task to create one.</div>';
  const attentionItems = resumable.filter(
    (t) => ["stalled", "blocked"].includes(t.execution?.state) ||
      t.execution?.progress_may_be_out_of_sync || t.progress?.current_step?.status === "blocked"
  );
  attention.innerHTML = attentionItems.length
    ? attentionItems.slice(0, 8).map((t) => `<div class="runtime-row">${activityStatusBadge(t.execution?.state || "blocked")} <span>${esc(t.title)}</span> <span class="muted">(${esc(t.id)})</span></div>`).join("")
    : '<div class="runtime-empty">Nothing needs your attention right now.</div>';
  board.querySelectorAll("[data-handoff]").forEach((b) => {
    b.addEventListener("click", () => {
      const task = tasks.find((t) => t.id === b.dataset.handoff);
      if (!task) return;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(missionHandoffPrompt(task)).then(() => toast("Handoff instructions copied to clipboard"));
      }
    });
  });
  renderWorkersList(runtimeInfo.workers);
  renderReadinessPanel(runtimeInfo.orchestration_readiness);
}

document.getElementById("add-server").addEventListener("click", () => openServerDialog(null));
document.getElementById("skills-refresh").addEventListener("click", () => loadSkills().catch((err) => toast(err.message, true)));
document.getElementById("skills-control-scope").addEventListener("change", () => loadSkills().catch((err) => toast(err.message, true)));
document.getElementById("recovery-review-btn").addEventListener("click", () =>
  reviewProjectRecovery().catch((err) => toast(err.message, true)));
document.getElementById("add-computer-use-presets").addEventListener("click", async () => {
  try {
    const result = await api("/api/upstream/presets/computer-use", { method: "POST" });
    toast(result.added.length
      ? "Computer-use presets added (disabled). Install the CLIs, then review and enable them."
      : "Computer-use presets already configured; no settings changed.");
    await loadServers();
  } catch (err) {
    toast(err.message, true);
  }
});
document.getElementById("save-env").addEventListener("click", async () => {
  const values = {};
  document.querySelectorAll("#env-form input").forEach((el) => (values[el.name] = el.value));
  try {
    await api("/api/config/env", { method: "PUT", body: JSON.stringify({ values }) });
    toast("Saved .env");
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById("import-file-btn").addEventListener("click", async () => {
  const filePath = document.getElementById("import-file-path").value.trim();
  const source = document.getElementById("import-file-source").value;
  if (!filePath) return toast("Enter a file path", true);
  try {
    const r = await api("/api/import/file", {
      method: "POST",
      body: JSON.stringify({ path: filePath, detect_as: source, merge: true }),
    });
    toast(`Import OK: ${r.imported.join(", ") || "(no new servers)"}`);
    await refreshAll();
  } catch (err) {
    toast(err.message, true);
  }
});

async function refreshAll() {
  await Promise.all([loadDashboard(), loadServers(), loadImport(), loadEnvForm(), loadProject().catch(() => {})]);
}

document.getElementById("refresh-all").addEventListener("click", () => refreshAll().catch((e) => toast(e.message, true)));

restoreAdminSession()
  .then((authenticated) => authenticated ? refreshAll().then(() => startDashboardRuntimeLoop()) : undefined)
  .catch((err) => toast(err.message, true));

const recentContainer = document.getElementById("dash-recent");
if (recentContainer) bindRecentToggle(recentContainer);

async function openLocalTools() {
  const data = await api("/api/local-tools");
  const enabled = new Set(data.overrides?.enabled || []);
  const disabled = new Set(data.overrides?.disabled || []);
  document.getElementById("local-tools-list").innerHTML = data.tools.map((name) => `<label class="field checkbox"><input type="checkbox" data-tool-enable="${esc(name)}" ${enabled.has(name) ? "checked" : ""} /><span>${esc(name)} <small class="muted">force enable</small></span><input type="checkbox" data-tool-disable="${esc(name)}" ${disabled.has(name) ? "checked" : ""} /><span>disable</span></label>`).join("");
  document.getElementById("local-tools-dialog").showModal();
}

document.addEventListener("click", (event) => {
  const button = event.target.closest('button[data-action="local-tools"]');
  if (button) openLocalTools().catch((err) => toast(err.message, true));
});

document.getElementById("close-local-tools").addEventListener("click", () => document.getElementById("local-tools-dialog").close());
document.getElementById("save-local-tools").addEventListener("click", async () => {
  const enabled = [...document.querySelectorAll("[data-tool-enable]:checked")].map((input) => input.dataset.toolEnable);
  const disabled = [...document.querySelectorAll("[data-tool-disable]:checked")].map((input) => input.dataset.toolDisable);
  await api("/api/local-tools", { method: "PUT", body: JSON.stringify({ overrides: { enabled, disabled } }) });
  document.getElementById("local-tools-dialog").close();
  toast("Saved. Open a new MCP chat to apply the changes.");
});