# Local ChatGPT Plus — detailed operations guide

This guide retains the advanced feature explanations, tools, configuration, security and troubleshooting details previously contained in the root README. Start with [README](../README.md); agent-specific usage is in [AGENTS.md](../AGENTS.md).

## Advanced capabilities

### Agent Skills (project and global)

Local ChatGPT Plus discovers skills from the current project's `.agents/skills`,
`.claude/skills`, and `.codex/skills` directories, followed by the same three
directories in the user's home folder. Additional global directories can be
supplied through `LOCAL_CODER_SKILL_DIRS` (OS path delimiter separated).
Project skills take precedence when multiple directories use the same skill name.
Restricted permission profiles hide skills outside configured filesystem roots.

Call `list_skills` to discover available skills, then `load_skill` to read one.
Both tools accept an optional `path` to explicitly choose a project root.
To read a supporting Markdown/text reference without reloading the entire skill,
pass `reference_path` to `load_skill`, for example `references/api.md`.
Reference paths are resolved inside their skill directory, and traversal or
symlink escapes are rejected. Installing a skill does not automatically enable
the programs or MCP tools that the skill describes.

The Admin UI's **MCP Servers → Agent Skills** panel can disable or re-enable
individual skills for a selected project or globally. It writes versioned
JSON controls to `<project>/.local-coder/skills.json` and
`~/.local-coder/skills.json`, respectively. A global disable always takes
precedence over the project toggle. Disabled skills are omitted from
`list_skills` and cannot be loaded by name. Invalid settings fail visibly.
The Admin UI saves individual toggles atomically, so simultaneous changes do
not overwrite unrelated skill controls. Skill name/description YAML scalars
support quoted values and folded descriptions; discovery uses bounded reads.

### Vercel computer-use MCP providers (agent-desktop + agent-browser)

Local ChatGPT Plus runs two complementary Vercel Labs computer-use providers
behind the native `computer_observe` and `computer_act` entrypoints. They are
installed, enabled, and configured in `profiles/mcp-upstream.json`, each with
`expose: meta_only` so no raw upstream tools are advertised to ChatGPT.

| | `vercel-agent-desktop` (native UI) | `vercel-agent-browser` (Chrome/CDP) |
|---|---|---|
| Purpose | Existing macOS apps, the visible desktop, native dialogs | Structured website navigation, DOM/accessibility snapshots, web forms |
| Package / command | `agent-desktop` (`agent-desktop mcp`) | `agent-browser` (`agent-browser mcp --tools all`) |
| Installed version | 1.3.1 (2026-11) | 0.43.0 (2026-11) |
| Controlled | Any macOS app with an accessibility tree: Finder, System Settings, Notes, native sheets/popovers/alerts, and Brave as a macOS window | Chrome-family browsers over CDP (Brave, Google Chrome, Edge); launched managed browser |
| Reached via | `computer_observe`/`computer_act` with `provider: "desktop"` | same with `provider: "browser"` |
| Key tools (allowlisted) | `desktop_snapshot`, `desktop_list_windows`, `desktop_find`, `desktop_screenshot`, `desktop_status`, `desktop_permissions`, `desktop_click`, `desktop_type`, `desktop_focus_window`, `desktop_scroll` | `agent_browser_snapshot`, `agent_browser_get_text`, `agent_browser_get_cdp_url`, `agent_browser_connect`, `agent_browser_open`, `agent_browser_click`, `agent_browser_fill`, `agent_browser_press`, `agent_browser_wait_for_*`, tab tools |

Installation (run once; install is not required again on every start):

```bash
npm install -g --allow-scripts=agent-browser,agent-desktop agent-desktop agent-browser
agent-desktop status        # platform + macOS accessibility/automation/screen-recording state
agent-browser doctor        # browser detection, encoders, headless launch
```

> npm blocks postinstall scripts by default. The two packages download native
> binaries in their postinstall; pass `--allow-scripts=agent-browser,agent-desktop`
> exactly once, or set those two in your per-user `allow-scripts` config.

How enabling works: the Admin UI **MCP Servers → + Computer-use presets**
action (or writing `profiles/mcp-upstream.json`) adds the two stdio servers.
Creating the entries neither installs nor runs them; the CLIs in the example
install commands are what start on demand. `computer_observe` and
`computer_act` are in the slim profile with an explicit allowlist, so the raw
Vercel catalog stays hidden. Input requires `allow_input=true` and an
unsafe-runtime-enabled permission profile. The `allow_input` flag is provided
by the caller; it is **not** independent proof of human approval. Host-side
confirmation depends on the MCP client.
Local ChatGPT Plus also has a separate macOS operator approval dialog for sensitive actions
(typing, form filling, connecting to CDP, navigation, and similar actions).
`MCP_COMPUTER_APPROVAL_MODE=sensitive` is the default; `all` requests approval
for every non-wait computer action, and `off` disables this additional gate
on explicitly trusted systems. The approval dialog defaults to No, times out
after 30 seconds and allows repeat actions in the same window/browser scope
for 90 seconds. CI fixtures use `off` so they do not control your real desktop.
This is an additional consent layer, **not** an OS sandbox: an unrestricted
terminal or a separate computer automation program could bypass it.
It can verify a fresh snapshot against `expected_text`; desktop input by
`ref_id` requires a recent `computer_observe` snapshot scoped to
`arguments.window_id` and a matching `verification_target.window_id`.
Refs are bound to the observed window and invalidated after input; this
prevents verifying the result in an unrelated foreground window.
Failed verification can trigger `screenshot_on_failure`, restricted to that
same window. Input is retried only if `safe_retries=1` is explicitly set and
the upstream declares `disposition.delivery=not_delivered` and
`disposition.retry=safe`; uncertain delivery is never replayed. Read-only screen
access also requires the unsafe-runtime permission. Review tool permissions
before enabling `all` upstream exposure.
After changing the exposed tools, reconnect/refresh the ChatGPT connector.

On macOS, MCP executables are launched directly from PATH without Windows batch shims.
The browser preset prefers installed Google Chrome and stores its own persistent
profile under the legacy-compatible macOS Application Support path (`~/Library/Application Support/ChatGPTLocalCoder/browser-profile`) rather than
using the user's ordinary Chrome profile. An optional end-to-end check is
`node scripts/test-vercel-mcp-live.mjs`; it uses a localhost fixture to verify
DOM interaction and MCP reconnect without modifying existing user apps.

The browser MCP process uses `--tools all` internally (not exposed directly
because `expose=meta_only`) to support `agent_browser_connect` for Electron.
The guarded `computer_act` interface allows CDP connection only to a
localhost port/endpoint and disallows session/namespace overrides.
Local ChatGPT Plus collects all paginated MCP tool-list pages with explicit bounds,
deduplication and a 60-second cache; the full browser provider currently
contains more than 100 tools, but only the native computer-use entrypoints
are advertised to ChatGPT.
The full-profile `mcp_call` fallback also enforces the upstream server's
`expose`/allowlist policy and local write/unsafe-runtime permission. It cannot
invoke hidden `meta_only` or disabled tools. Structured upstream failures are
reported as errors, not successful calls.
Direct upstream proxies use the same conservative write/unsafe-runtime
restriction even if the remote tool claims `readOnlyHint=true`: annotations
from other servers cannot weaken the local permission boundary. This means
strict read-only profiles cannot call direct upstream tools unless they use
the approved native read-only integration instead.

#### How ChatGPT chooses between the two providers

Both providers are enabled and wait for the `provider` argument:
`computer_observe`/`computer_act` take `provider: "desktop"` or
`provider: "browser"`. Prefer:

- **`browser`** for structured website navigation, scraping permitted page
  content, web forms, and browser workflows, whenever the browser connection is
  actually available (a managed browser is launched, or a CDP connection is up).
- **`desktop`** for existing macOS applications, the user's visible
  authenticated Brave window, native dialogs, and situations where CDP browser
  attachment is unavailable.

ChatGPT selects either based on the task and what is live. Ordinary
browser/desktop actions are performed directly through these providers; OMP or
another AI model is **not** started to proxy them.

#### Attaching to the existing authenticated Brave window (no cookie copying)

Two supported paths, both preserving the user's real Brave session and cookies:

1. **Desktop (recommended when it is visible):** leave Brave running. Call
   `computer_observe` `desktop_list_windows` / `desktop_snapshot` with the
   Brave window to read it, and act on it with `desktop_*` tools. No
   restart, profile change, or debugging endpoint is involved.
2. **Browser via CDP:** launch Brave with an explicit loopback debugging port,
   e.g. `"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" --remote-debugging-port=9222`,
   then `computer_act` `agent_browser_connect` with `target: "9222"` (a
   localhost port or explicit loopback HTTP/WS endpoint; the allowlist rejects
   everything else). This attaches to the **existing authenticated** profile;
   authentication is read from the live session and is never copied.

Local ChatGPT Plus will **not** restart Brave, change its profile, expose a
debugging endpoint publicly, or copy browser cookies on its own. If no CDP
attach is possible, agent-browser uses a separate, managed Chrome-family
profile for Browser Tests; in that independent profile any site login must be
done explicitly (it does **not** carry the user's Brave authentication). That
is the safe fallback and is documented as a limitation, never bypassed.

The always-isolated managed browser profile lives at
`~/Library/Application Support/ChatGPTLocalCoder/browser-profile`
(`AGENT_BROWSER_PROFILE` in the upstream config), separate from the user's
Brave/Chrome profile.

#### macOS permissions and approval prompts

- **Accessibility** — required by `agent-desktop` to read/operate the
  accessibility tree. Initially denied. Approve manually:
  `agent-desktop permissions --guide` opens System Settings >
  Privacy & Security > Accessibility (Device Control and Data Access on
  macOS 27+) and shows which app to drag in (usually the terminal/host that
  launches the server). Grant only Accessibility; nothing broader.
- **Screen Recording** — needed only for `desktop_screenshot`; reported as
  granted or requested separately.
- **Automation** — requested only when controlling other apps through Apple
  events; deny when not needed.
- **Local operator approval dialog** — for sensitive `computer_act` actions
  (typing, form filling, CDP connect, navigation, and similar) Local ChatGPT
  Plus shows its own 30-second macOS dialog that defaults to **Deny**. It
  leases repeat access in the same window/browser scope for 90 seconds.
  `MCP_COMPUTER_APPROVAL_MODE=off` disables this extra gate only on explicitly
  trusted systems; CI uses `off`.

These are real macOS consent boundaries. Full/YOLO application permissions do
**not** bypass them, Auth0, provider approval gates, or the Secure MCP Tunnel.

`tccutil reset Accessibility <path>` cannot revoke a bare, unbundled binary
like `node` (macOS returns `No such bundle identifier`), and
`tccutil reset Accessibility` with no argument would clear every app's grant,
so `lcp` does not try to automate the TCC toggle. Instead, `lcp off` (and
`lcp toggle` turning OFF) opens the **Privacy & Security → Accessibility**
pane for a one-click toggle of the `node` grant, and `lcp on` / restarts print
a reminder to re-enable it before desktop automation is used again.

#### Startup, health checks and troubleshooting

- Both servers auto-start on demand via the upstream stdio transport when a
  computer-use call arrives; they idle-disconnect after 10 minutes by default.
- Health: Admin UI **MCP Servers** view, or `POST /api/upstream/:id/test`;
  goals are `health: connected`, `expose: meta_only`, `proxied_tools: []`.
- CLI self-checks: `agent-desktop status`, `agent-browser doctor`.
- Failure messages distinguish the four cases:
  - `PERM_DENIED` / `Accessibility permission not granted` → denied macOS
    permission (grant it manually; no action was delivered, `retry: safe`).
  - `Upstream server disabled` / `not enabled` → `vercel-agent-*` not enabled.
  - `Upstream connection timed out` / `command not found` → provider or PATH
    unavailable (install the CLI; ensure launchd PATH has the npm bin).
  - A per-page `error.code` from agent-browser (e.g. navigation/timing) →
    actual website error, retried only when `disposition.retry=safe`.

#### Activity feed and logs

`computer_observe`/`computer_act` calls appear in the Admin UI activity feed
(`/api/activity`, TUI). The audit path records only the tool name, provider,
and status — never window/page content, screenshots, refs, or approval scope
values. `sanitize-activity` additionally redacts secret-shaped strings and
sensitive keys from every logged `details` object, so desktop/browser
screenshots and DOM text do not reach logs or telemetry. The providers'
own docs warn that snapshots/clipboard/screenshots can contain private
desktop content; keep returned observations out of public logs/uploaded
artifacts.

#### Dependency and maintenance

Both providers are pinned in the npm global install above. Recurring
dependency-freshness, compatibility, and security maintenance (monthly, with
advisory-driven reviews) is tracked in
[`MAINTENANCE_BACKLOG.md`](../MAINTENANCE_BACKLOG.md). See the "Dependency
maintenance" task there for the check command, upgrade policy, rollback, and
next review date.

### Reviewing stale task records

Use `agent_task(action="review", workspace="/Users/you/Projects/project", stale_hours=24)`
to identify old active/blocked plans, active coding loops, and active edit
transactions in **only that workspace**. The report includes linked loop and
transaction status, registered workers, record counts, and suggested manual
recovery actions. It does not expose transaction snapshot contents, and a
stale record is not automatically considered disposable. Pass a task `id` to
inspect only that task and its linked loop/transaction; omit it to include
standalone transactions in the workspace. Review is strictly read-only:
it never marks a task complete, deletes transactions, or edits other projects.
An isolated worktree transaction is included only when it is explicitly linked
to a coding loop belonging to the selected source project and its transaction
workspace matches that loop's worktree exactly. Unrelated worktree records are
excluded.
Listings have explicit scan and output limits, reported in `source_limits`.
Explicit task updates now validate an optional `workspace` against the task's
stored project and reject cross-project mutations from project-bound MCP
sessions. Task state is not an autonomous worker. When a completed checklist
step is reopened, its old `completed_at` timestamp is cleared; older records
with that inconsistency are normalized in memory without rewriting their
historical files simply because they were read.

`project_context` uses bounded file-handle reads rather than loading an entire
file when only its first `max_bytes_per_file` bytes are requested (valid range:
1–200,000 bytes). Cached prefixes are reused only while the file size and
modification/change times still match. `node scripts/test-context-prefix.mjs`
verifies this using an isolated 32 MiB fixture: a 1 KiB requested prefix
performs 1 KiB of cold reads instead of 32 MiB, a 32,768× reduction in file
bytes read for that case. This is an I/O measurement, **not** a claim of a
32,768× latency or token-usage improvement.

The `CLAUDE.md`/`AGENTS.md` project-memory injector also uses bounded streaming
for root files and nested imports, retaining configured byte/line limits,
import order, code fences, comment handling and truncation reporting. Run
`node scripts/test-project-memory-bounded.mjs` after building to check its
legacy-equivalent output and large-file I/O limits.

The Admin UI's **Project → Workspace recovery review** panel exposes the same
project-scoped, read-only status through
`GET /api/recovery/review?workspace=<project-path>&stale_hours=24`.
The panel requires you to enter a project path and press **Review records**;
it never polls other projects or changes a task, loop or transaction.
The response contains bounded record summaries, no snapshot payload paths,
and `source_limits.potentially_incomplete` when a store scan reached its cap.
The endpoint is covered by the normal localhost/Admin authentication controls.
Run `node scripts/test-admin-recovery.mjs` for isolated API isolation and
concurrent-request tests; no live durable records are used by that test.

The Windows-only live desktop/Electron tests from the original repository
are intentionally excluded from this macOS snapshot. Browser MCP remains
an independent, opt-in integration, protected by the local macOS operator dialog.

Vercel sources: [agent-desktop](https://github.com/vercel-labs/agent-desktop)
and [agent-browser](https://github.com/vercel-labs/agent-browser).

## Live terminal dashboard

Interactive launches use a clean alternate-screen TUI instead of scrolling request logs. **By default the TUI follows the current terminal width and height, including manual resizing**, rather than capping the dashboard at 44 rows or 160 columns. Color stays restrained to meaningful state accents. TUI v2 prioritizes **current work and project clarity**: active projects are automatically listed first, followed by connected-idle and offline projects; each row shows ChatGPT transport, active-tool, worker, and coding-loop counts. Active tools and workers include their project, worker liveness and last activity are visible, and a pinned Health footer surfaces conditions such as **CHAT TRANSPORT LOST · work continues**, stalled/silent workers, or tunnel degradation. The dashboard still keeps the latest completed tool calls plus CPU, RSS, heap, tunnel, and transport status. Narrow/tiny terminals fall back to compact resize-safe layouts; non-interactive/CI/redirected output automatically falls back to normal logs.

The desktop dashboard allocates more rows to active projects and workers when space permits, prioritizes stalled/silent jobs, and distinguishes background work from true idleness. External labels, tool output summaries, and diagnostic messages are sanitized before reaching the terminal; unchanged full-size frames are not needlessly cleared and redrawn.

The TUI is also an interactive operator console when both stdin and stdout are terminals. Press **1** for Overview, **2** for Workspaces, **3** for History, **4** for Workers, **5** for Logs, or **?** for the complete keyboard help. Use **Tab** to cycle views and arrows, J/K, Page Up/Down, or Home/End to navigate. On Workspaces, **S** switches active-first/recent/name sorting, **P** pins/unpins a saved project, and **X** unregisters an unused project after confirmation—**no files or Git worktrees are ever deleted**. History supports **E** (errors only). History and Logs support **C** to archive the current audit log and clear the visible feed after confirmation; the original log is preserved under the audit directory's \`.mcp-state/audit-archive\`. **R** refreshes the registry and saved history. Esc cancels, Q returns to Overview, and Ctrl+C retains its normal server shutdown semantics. Without an interactive stdin the TUI remains view-only; Admin UI and MCP tools remain available.

Set `LOCAL_CODER_TUI=off` to force traditional logs, or `LOCAL_CODER_TUI=on` to request the dashboard when stdout is a TTY. `LOCAL_CODER_TUI_HEIGHT=auto` (default) follows the entire terminal height. A numeric value such as `44` caps the dashboard height to 20–60 rows and attempts one initial terminal resize if the window is shorter; terminals may ignore this request. In auto mode the app does not change the window dimensions itself.

Set `WORKSPACE_PATH` to your project root (absolute path). With `MCP_TOKEN` set, the MCP endpoint becomes `/mcp/<token>` — that full path is what goes in the connector.

## Tunnel options

### Option A — OpenAI Secure MCP Tunnel *(recommended, live OAuth deployment 2026-11-20)*

Connects a private/localhost MCP server to ChatGPT without exposing port 3000
to the public internet. `tunnel-client` opens an outbound HTTPS long-poll to
OpenAI and forwards MCP requests to `http://127.0.0.1:3000/mcp` locally. The
live deployment runs **`INBOUND_AUTH_MODE=oauth`**, so the ChatGPT **Add custom
MCP server → Connection: Tunnel** form uses **Authentication: OAuth** (Auth0
login + consent + per-tool scopes) instead of a static token. The tokenized
"No authentication" path is the documented fallback (see "Fallback" below).

Prerequisites (all require browser access to the OpenAI Platform org):

- Tunnels **Read + Manage** to create/edit a tunnel; **Read + Use** to run
  `tunnel-client` or select the tunnel in ChatGPT.
- A `tunnel_id` from [OpenAI Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels).
- A runtime API key (Platform → API keys) used as `CONTROL_PLANE_API_KEY`.
- The tunnel must be associated with the target ChatGPT workspace, not only a
  Platform organization, or it will not appear in the ChatGPT form.

Install the official client (Homebrew is the supported macOS path; downloaded
ZIPs are not notarized and may be blocked by Gatekeeper):

```bash
brew install openai/tools/tunnel-client
tunnel-client --version
tunnel-client help quickstart
```

Configure a profile that points at the local MCP server. Put the runtime key
in a 0600 file and reference it so it is never in a command line or log:

```bash
mkdir -p ~/.config/tunnel-client
install -m 600 /dev/null ~/.config/tunnel-client/runtime.key   # then paste the runtime key into that file
```

```yaml
# ~/lcp-tunnel.yaml  (chmod 600)
control_plane:
  tunnel_id: "tunnel_<…>"
  api_key: "file:/Users/YOU/.config/tunnel-client/runtime.key"
log:
  level: info
  format: struct-text
health:
  listen_addr: 127.0.0.1:8090
mcp:
  server_urls:
    - channel: main
      url: "http://127.0.0.1:3000/mcp"   # oauth mode: no token path
  oauth_trusted_origins:
    - "https://api.openai.com"
    - "https://<your-auth0-tenant>.eu.auth0.com"
harpoon:
  allow_plaintext_http: true
```

The **tokenized** fallback profile instead points at
`http://127.0.0.1:3000/mcp/<MCP_TOKEN>` (health `8080`) and omits the
`oauth_trusted_origins`/`harpoon` blocks.

Validate, then run it in a terminal while the MCP server is up:

```bash
tunnel-client doctor --profile-file ~/lcp-tunnel.yaml --explain
tunnel-client run --profile-file ~/lcp-tunnel.yaml
# in another terminal:
curl -fsS http://127.0.0.1:8090/readyz
open http://127.0.0.1:8090/ui
```

Keep `tunnel-client run` healthy during ChatGPT plugin discovery and every tool
call. See [the Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
for the full flow and limits (600 req/min, 10 MiB envelope, 120 s deadline).

The verified deployment uses `MCP_SESSION_RECOVERY=false` in `.env`: the
tunnel-client startup probe sends a fresh initialization request, and the
server's recovery path rejected that probe's second initialization. This
setting means a restart requires a fresh MCP initialization; ChatGPT normally
does that when the connector is refreshed or a new chat starts. **Validated
2026-11-20:** a `tunnel-client` restart severs in-flight MCP transports, so a
conversation that is mid-tool-call at that moment reports `McpServerError:
Session terminated` and cannot resume that session (no recovery). A **fresh
conversation (new transport) reconnects cleanly** once the tunnel is ready —
no server restart or connector reauthorization is required. In practice this
means: after any server/tunnel restart, start a new chat or refresh the
connector rather than retrying in the interrupted conversation.

The built-in tunnel supervisor (`src/lib/tunnel-supervisor.ts`) can manage
`tunnel-client` inside the MCP process lifecycle when
`LOCAL_CODER_MANAGE_TUNNEL=1` plus `OPENAI_TUNNEL_ID` and
`OPENAI_TUNNEL_API_KEY` are configured and a macOS-compatible `tunnel-client`
is installed. It writes `profiles/codex-local.yaml` (gitignored) and polls
`/readyz`. Enable it only after checking the credentials and client; otherwise
run `tunnel-client` as its own process as above.

Get credentials: [OpenAI Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels)

### Option A lifecycle commands

Start in two terminals:

```bash
cd /Users/you/repos/local-chatgpt-plus
npm start
# second terminal:
tunnel-client run --profile-file ~/lcp-tunnel.yaml
```

Check:

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:8090/readyz
```

Stop with `Ctrl+C` in both terminals. For non-interactive cleanup, stop only
the processes started with these commands; do not kill unrelated Node or SSH
processes. Confirm ports 3000, 3001, and 8090 are closed before considering
the deployment stopped.

The deployment is **verified working**: real ChatGPT conversations authenticate
through Auth0 and make live read/write/command/Git tool calls. The earlier
"Create as a plugin" platform-gate blocker is **resolved** — the root cause was
a stale `dist` build with an empty algorithm-allowlist in the OAuth verifier,
not the tunnel or plugin form (see the deployment report §9.2). This historical
evidence is preserved in `MAINTENANCE_BACKLOG.md` (D.7/D.9).

#### Reconnection and controlled restart (validated 2026-11-20)

- `tunnel-client` reconnects automatically: on control-plane long-poll
  timeouts/network errors it backs off and recovers without a process restart
  (observed 15:36–18:31, recovered 18:31).
- A manual `tunnel-client` restart takes ~2 s to reach `readyz` ready; a fresh
  ChatGPT conversation reconnects cleanly with no reauthorization. In-flight
  conversations interrupted by the restart report `Session terminated` and
  should be continued in a new chat.
- The MCP server itself does not need a restart for reconnect; durable state
  lives under `.mcp-state/` (gitignored) and is preserved across restarts.

#### Managed startup — `lcp` controller (recommended, active 2026-11-20)

The preferred way to run the deployment is the **`lcp` controller**: two
per-user `launchd` jobs that are bootstrapped on demand and fully unloaded by
`lcp off`. Because the service definitions live in `~/.local/lcp/launchd/`
(outside the auto-loaded `LaunchAgents` folders), **nothing starts at login**.
While a job is loaded, `launchd` supervises (`KeepAlive`) and restarts it after
an unexpected crash; `lcp off` unloads both so they cannot restart.

The Admin dashboard distinguishes this external `launchd` tunnel from the
optional in-process supervisor. When the internal supervisor is off, the
read-only dashboard observer verifies the exact `com.localchatgpt.plus.tunnel`
job, its local MCP route and its loopback `/readyz` endpoint (normally port
8090). A valid running/healthy job displays **Tunnel ONLINE · launchd-managed ·
health :8090**, with restart count derived from launchd starts. If the job is
unrecognized, it displays **NOT MONITORED**, not a misleading assertion that
all tunnels are disabled. Verification results are cached for four seconds.
This observation never starts or restarts a service and does not require
`LOCAL_CODER_MANAGE_TUNNEL=1`; do **not** enable a second supervisor just to
change the dashboard label. The existing controller remains the authority for
`lcp on`, `lcp off`, `lcp status` and production restarts.

Install (from the checkout):

```bash
scripts/lcp-install.sh     # copies scripts/lcp -> ~/.local/bin/lcp and writes ~/.local/lcp/state/config
lcp on                     # start (default: Workspace mode)
lcp off                    # stop + disable auto-restart
lcp status                 # state / health / ownership / access mode
lcp restart [--mode <m>]   # controlled restart (preserves mode unless overridden)
lcp toggle                 # OFF→ON(Workspace) / ON→OFF; refuses PARTIAL; never Full
lcp mode <workspace|projects|full>   # safe controlled switch (off→on in that mode)
lcp migrate                # take over legacy OMP/terminal-owned server+tunnel
```

Key behaviors:

- **Independent of OMP/Terminal:** jobs run in the per-user `gui` domain with
  `PPID 1` (`launchd`), so they survive the launching shell exiting.
- **Idempotent & concurrency-safe:** `lcp on` when already ON is a no-op; a
  `mkdir` lock serializes concurrent invocations; only the missing service is
  started after a partial state.
- **Auto-opens the Admin dashboard on `lcp on`:** from an interactive terminal,
  a fresh `lcp on` opens `http://127.0.0.1:3001/ui` exactly once after the
  Admin UI is ready. Headless/daemon/automation contexts and `lcp restart`,
  `lcp mode`, and `lcp toggle` never auto-open (no focus stealing). Set
  `LCP_OPEN_DASHBOARD=0` to disable.
- **No broad kills:** `lcp off`/`lcp migrate` act only on the two managed jobs
  (or the two recognized legacy processes), never `pkill -f node` or unrelated
  PIDs.
- **Explicit access-mode selection** with generated, ignored permission files
  under `~/.local/lcp/profiles/permissions.<mode>.json`; the server is launched
  with `PERMISSIONS_CONFIG` pointing at the chosen file, and `lcp status` reads
  the **live** `/health` profile rather than trusting a file on disk.
- **Rollback / restore:** stop with `lcp off` and verify ports 3000/3001/8090
  are closed; if OAuth must be disabled entirely, see the tokenized fallback
  steps below.

##### Access modes

| Mode | Command | Profile | Direct filesystem roots | unsafe runtimes |
|---|---|---|---|---|
| Workspace | `lcp on` (default) | `workspace` | `/Users/you/lcp-disposable` | blocked |
| Projects | `lcp on --mode projects` | `custom` (multi-root) | `~/repos`, `~/Downloads`, `~/lcp-disposable` | blocked |
| Full / YOLO | `lcp on --mode full` | `open` | unrestricted (OS ACLs apply) | allowed |

`lcp on` always resets to **Workspace**. Full/YOLO requires an interactive
`YES` confirmation (`LCP_FULL_CONFIRM=1` only for deliberate scripted use) and
is **never** triggered by `lcp toggle`. Auth0 authentication, audience-bound
JWT validation, per-tool OAuth scope checks, and tunnel isolation remain active
in every mode. These profiles are **application-level policy, not an OS
sandbox** — a permitted shell command can read/send data outside the roots.

`lcp status` reports `ON / OFF / PARTIAL / ERROR`, process ownership
(`owned-by-controller=yes/no`), live server/tunnel health, `authMode`, the
effective access mode and permission profile, allowed roots, whether
unrestricted runtimes are allowed, and any unexpected listeners on
3000/3001/8090. It never prints secrets.

##### Owned delegated workers (Phase 7C orchestration)

Independently-running, owned workers (e.g. an OMP/model-backed subagent) are
persisted by the MCP server in a durable, bounded registry at
`$LCP_REPO/.mcp-state/workers/index.json` (`MCP_WORKER_STATE_DIR` overrides the
root). Each record carries a stable run id, `source`
(`omp-subagent`/`computer`/`chatgpt-direct`/…), status (`queued`, `running`,
`waiting_for_user`, `blocked`, `completed`, `failed`, `cancelled`,
`interrupted`), objective, workspace, provider/model, cost limits, pid and
`lifecycle_owner`. Terminal statuses are never resurrected by a late crash.

The Admin UI **Missions** view shows two related panels:

- **Delegated workers** — live owned workers with source badge, status, age,
  and a **Cancel** action (calls `POST /api/workers/:id/cancel`, which routes to
  `subagent stop` for `omp-subagent` runs). ChatGPT-direct tool calls are **not**
  listed as separate workers.
- **Delegation readiness** — an honest, non-secret status of the two delegation
  paths: whether the OMP/model-backed subagent runner is enabled/configured/its
  model is resolvable, and whether a computer-use provider is enabled, whether
  unsafe runtimes are allowed, and the always-external `computer:use` scope
  state (never claimed as granted from inside the resource server).

`lcp off` is **fail-closed on owned workers**: after the two jobs are unloaded
and ports 3000/3001/8090 are closed, it reads the registry and, if any
non-terminal `local-mcp`-owned worker is still recorded active, returns a
**PARTIAL** status (nonzero exit) listing the worker ids rather than claiming a
clean OFF. `lcp status` always reports the count of non-terminal owned workers.
This prevents an unattended worker from being mistaken for stopped work when
the in-process shutdown hook is interrupted.

##### macOS Shortcuts

`scripts/gen-shortcuts.sh` writes importable `.shortcut` files to `shortcuts/`
for **ON**, **OFF**, **Toggle** (posts an ON/OFF notification), **Status**
(posts a notification), and **Projects**. Import by double-clicking each file in
Finder and choosing **Add Shortcut** in the Shortcuts app, then run it once and
grant the requested Automation permission. There is **no Full/YOLO shortcut**:
`lcp on --mode full` needs the interactive `YES` confirmation a Shortcut cannot
provide, so it stays Terminal-only.

##### Manual (two-terminal) lifecycle

The same commands used before the controller, for debugging or a bare run:

```bash
cd /Users/you/repos/local-chatgpt-plus && npm start
tunnel-client run --profile-file ~/lcp-tunnel.yaml

curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:8090/readyz
tunnel-client doctor --profile-file ~/lcp-tunnel.yaml --explain
```

Stop with `Ctrl+C` in both terminals (only those processes). Confirm ports
3000, 3001, and 8090 are closed before considering the deployment stopped.

##### Rollback to tokenized fallback (if OAuth must be disabled)

1. Edit `.env`: `INBOUND_AUTH_MODE=token` (keep `MCP_TOKEN` set).
2. Restore the tokenized tunnel profile (`server_urls` → `/mcp/<MCP_TOKEN>`,
   health `8080`, no OAuth blocks).
3. `npm start` + `tunnel-client run`, then reconnect ChatGPT with **No
   authentication**.

### Option B — Cloudflare Quick Tunnel

Free, but the HTTPS URL changes on each restart. Requires `cloudflared`
(e.g. `brew install cloudflared` on macOS).

```bash
# Terminal 1
npm start
# Terminal 2
npm run tunnel  # cloudflared tunnel --url http://localhost:3000
```

**Requires outbound port 7844** (TCP *and* UDP) to `*.argotunnel.com`. Many corporate/school/hotel networks block it, and `--protocol http2` does **not** help — it still uses 7844. Check with:

```bash
cloudflared tunnel --url http://localhost:3000 2>&1 | grep -E 'precheck|Registered'
```

If you see `TCP Connectivity … status=fail` and never `Registered tunnel connection`, the network is blocking it — use Option C.

### Option C — Pinggy *(works when Cloudflare is blocked)*

Pure SSH over port **443**, so it survives networks that block 7844. No install, no signup.

```bash
# Terminal 1
npm start

# Terminal 2
ssh -p 443 -R0:localhost:3000 a.pinggy.io
```

It prints two HTTPS URLs (`https://….free.pinggy.net` and `https://….run.pinggy-free.link`) — pick either and append `/mcp/<MCP_TOKEN>` for the connector.

Free sessions expire after **60 minutes** and the URL changes each time, so you re-paste the connector URL. A paid plan gives persistent URLs.

## Tool reference

Native tools use structured JSON responses `{ ok, tool, summary, data }`. The source-of-truth catalog is `src/lib/tool-profile.ts`; `scripts/test-tool-profile.mjs` verifies it matches the native `server.registerTool()` declarations.

The default `slim` profile is intentionally optimized for regular ChatGPT: it currently exposes **42 high-value tools** while the `full` profile keeps all native tools. Redundant convenience/low-level tools hidden from `slim` remain available through `CHATGPT_TOOL_PROFILE=full`, Admin → **MCP Servers → Local tools**, or a `run_command` fallback. This keeps the default MCP discovery payload comfortably below the Phase 4 budget without removing local capability. The source-of-truth catalog is `src/lib/tool-profile.ts`.

### Agent production benchmark

Run the production benchmark/fault suite with:

```bash
npm run benchmark:agent
```

It starts isolated real MCP servers and checks the intended Codex-like workflow rather than only unit-level functions: compound repo inspection/read round trips, repository intelligence, verification-output compaction, durable `coding_loop` restart/resume, `context_capsule` recovery after a simulated lost ChatGPT/MCP session, fail → diagnose → repair → pass behavior, and malformed persistent-state resilience. Phase 4 guards the default profile at **≤50 slim tools**, **≤64 KiB `tools/list`**, **≤12,000 instruction characters**, and bounded high-level tool responses so future features cannot silently inflate ChatGPT context/transport cost.

Phase 5 adds a fault-focused efficiency suite:

```bash
npm run test:phase5
```

It covers concurrent idempotency, crash-resumable parallel batches, dirty-worktree mutation detection, ambiguous project aliases, verification-cache invalidation, cache coherency, runtime-identity side effects, ephemeral-state pruning, large-result handles, structured no-match errors, and runtime telemetry. These tests exist specifically to catch orchestration failures that can pass ordinary compile/unit checks.

Phase 6 adds reliability/isolation coverage:

```bash
npm run test:phase6
```

It verifies that fresh ChatGPT MCP transports do not inherit hidden shell cwd, explicit per-call project scope blocks accidental cross-project mutation, durable task/capsule state survives changing transport IDs, moved Git repos reconcile by remote identity, abandoned transactions preserve current files, automatic context checkpoints deduplicate unchanged state, and the integrated tunnel supervisor has safe disabled/unconfigured states.

> ChatGPT can create a **fresh MCP transport for individual tool calls**. A transport/session ID is therefore diagnostic metadata, not a durable chat/work owner. Project isolation is derived from explicit `path`, `workspace`, and `working_directory` arguments plus durable task/loop/transaction IDs.

### Onboarding *(call these first)*

| Tool | Description |
|------|-------------|
| `agent_status` | Permissions, workspace roots, runtime/schema identity, and `mode=doctor` memory/cache/recovery diagnostics |
| `project_context` | Reads AGENTS.md, README, CLAUDE.md, configs |

### Filesystem

| Tool | Description |
|------|-------------|
| `read_text_file` | Read source files (offset + limit) |
| `read_files` | Read up to 24 independent files/ranges in one bounded MCP call |
| `write_file` | Create or overwrite files |
| `edit_file` | Find-and-replace edits |
| `multi_edit` | Multiple edits in one file |
| `replace_regex` | Regex replace in file |
| `apply_patch` | Unified / Codex-style patches |
| `glob` | Find files by pattern (sorted by mtime) |
| `grep` | Search content (content / files / count modes) |
| `list_directory` | List folder contents |
| `directory_tree` | Recursive tree as JSON |
| `create_directory` | Create folders |
| `delete_file` / `delete_directory` | Remove files or dirs |
| `copy_file` / `move_file` | Copy or rename |
| `read_file_base64` / `write_file_base64` | Binary file support |

### Shell

| Tool | Description |
|------|-------------|
| `run_command` | Run bounded shell commands (`npm test`, builds, …). Supports optional idempotency/mutation tracking and transaction-aware shell edits |
| `run_commands_parallel` | Run independent commands concurrently in isolated shell processes; batches persist per-member completion so failed/incomplete members can be retried without rerunning successful siblings |
| `shell_status` / `shell_reset` | Transport-local shell state. ChatGPT calls do **not** share hidden cwd by default; use explicit `working_directory` |
| `start_process` | Long-running / background commands |
| `process_status` / `process_output` | Inspect live background jobs and logs; use their wait conditions instead of sleep/poll loops when waiting for exit or expected output |
| `process_history` | Persistent named operation history across MCP/server restarts; stale running jobs are reported as interrupted |
| `process_input` | Send piped stdin to prompts/REPLs (`append_newline`, optional EOF); not a full PTY |
| `stop_process` | Stop the background process tree (important for dev servers on macOS) |
| `pty` | Real PTY session for TUIs, debuggers, interactive installers, and terminal-native CLIs |

### Semantic + visual tools

| Tool | Description |
|------|-------------|
| `repo_intel` | High-level repository symbol search, references, and impact analysis. Uses LSP first and bounded lexical coverage/fallback |
| `lsp` | Hover, definition, references, document/workspace symbols, and diagnostics. TypeScript/JS + Python are bundled; clangd/rust-analyzer/gopls are detected when installed |
| `view_image` | Return a local PNG/JPEG/WEBP/GIF path as MCP image content for ChatGPT visual analysis |

### Git

| Tool | Description |
|------|-------------|
| `git_status` / `git_diff` / `git_log` | Inspect repo |
| `git_worktree` | List/add/remove/prune isolated local worktrees for parallel tasks |
| `git_add` / `git_commit` | Stage and commit |
| `git_branch` / `git_checkout` | Branch list, create, switch (local only) |
| `git_restore` | Restore tracked files to last commit |
| `git_push` / `git_pull` | Sync with configured remote |
| `git_stash` / `git_reset` | Stash and reset |

### Tool profiles

`CHATGPT_TOOL_PROFILE=slim` is the default for the ChatGPT app and advertises the core coding set. `CHATGPT_TOOL_PROFILE=full` advertises every native tool in the catalog. The Admin UI can force-enable or disable individual local tools without changing the base profile. Unknown/stale override names are filtered.

The default slim profile intentionally exposes high-value local development helpers while keeping more destructive/remote/redundant operations such as recursive directory deletion, Git reset/push/pull/checkout, raw binary writes, and low-level MCP calls opt-in.

### Agent task state

| Tool | Description |
|------|-------------|
| `agent_task` | Persist/resume a multi-step coding objective with structured `pending` / `in_progress` / `completed` / `blocked` / `skipped` plan steps |
| `inspect_project` | One-call repository reconnaissance: manifests, scripts, package manager, Git state, top-level layout, and language/file distribution |
| `verify_project` | Discover or run a deterministic bounded verification recipe and return compact pass/fail evidence. Successful-result caching is opt-in and keyed to Git/worktree state with a short TTL |
| `edit_transaction` | Begin a durable touched-file transaction, preview its aggregate diff, run verification, then accept or conflict-safe rollback |
| `coding_loop` | Durable Codex-like implementation loop: begin/resume/refresh/verify/finish/rollback/cleanup with bounded repair attempts and optional Git-worktree isolation |
| `coding_loop_status` | Read recent or specific persistent coding-loop state without requesting a mutating tool |

**Verified edit-loop safety:** When you begin a `coding_loop`, use its `transaction_id` for supported file edits (and provide `mutation_paths` for transaction-linked shell edits). Every such edit invalidates the prior verification. After `coding_loop(action=verify)` passes, `finish` checks fingerprints of the transaction's tracked files again; edits made afterward—including out-of-band modifications to those tracked files—require another verification, unless you explicitly opt into `allow_unverified=true`. `coding_loop_status` reports `verification_current` and any invalidation reason. Rollback also checks all baseline snapshot hashes before changing any workspace files, preventing partial restoration when a stored snapshot is missing or corrupt. **Only paths captured by the transaction are included in this protection**; unrelated edits must be reviewed separately.
| `context_capsule` | Save/resume a bounded semantic working summary plus current task/loop/transaction/Git/activity state across chat loss or reconnects |

The agent loop is deliberately split between **regular ChatGPT** and Local ChatGPT Plus: ChatGPT performs reasoning and decides the next action; Local ChatGPT Plus persists the objective/plan/progress, local operations, verification evidence, files, shell, Git, code intelligence, and a compact resumable working-context capsule. `agent_task` therefore adds durable coding-agent structure without starting another model or hidden subagent.

Large textual command/search results can be compacted into a durable result handle instead of being pushed through the MCP response in full. The returned handle can be read in bounded ranges, keeping ChatGPT context and tunnel payloads predictable. Mutating shell commands can also attach worktree-change evidence so transaction/recovery state reflects edits performed through shell scripts, Python, build scripts, or other command-line tools rather than only Local ChatGPT Plus's direct file-edit tools.

### ChatGPT context compaction / loss

Local ChatGPT Plus does **not** assume the ChatGPT host will automatically compact a long coding conversation. It also cannot inspect ChatGPT's hidden token counter or retrieve a lost private transcript. Instead, `context_capsule` uses two complementary layers:

- **automatic machine-state snapshots** at important task/loop/transaction boundaries and after a bounded tool-call/result-byte budget; these capture current Git/task/coding-loop/transaction/recent-tool state without model involvement;
- **semantic checkpoints** written by regular ChatGPT after important decisions or when Local ChatGPT Plus returns a `context_checkpoint_hint`; these keep the compact summary, decisions, findings, blockers, next steps, and important files that cannot be reconstructed reliably from machine state alone.

This cannot literally shrink an already-running ChatGPT conversation: MCP has no API to delete old host messages or inspect the exact hidden token budget. After several context-budget cycles (three by default), the hint sets `rollover_recommended=true`. At a safe boundary, checkpoint and continue in a fresh ChatGPT chat; the new chat resumes the capsule instead of rediscovering the project. That checkpoint-and-rollover path is Local ChatGPT Plus's application-level substitute for host auto-compaction.

When a chat is new, corrupted, or missing prior reasoning, ChatGPT should call `context_capsule(action="resume")` first and then reconcile the returned live state before doing more repository discovery. `remember()` remains for long-lived project facts; `context_capsule` is the short-lived resumable working handoff for the current task.

For a non-trivial task the intended flow is:

```text
inspect_project → agent_task(start/resume) → coding_loop(begin) → edit(transaction_id) → context_capsule(checkpoint) → coding_loop(verify) → repair/verify → finish or rollback
```

`coding_loop` does **not** run another AI model. Regular ChatGPT still reasons, chooses edits, and interprets failures; Local ChatGPT Plus supplies the durable state machine around it. Each loop owns one `edit_transaction`, records compact verification evidence, limits repair attempts, and can resume after an MCP/chat reconnect. A failed loop only receives more attempts through an explicit `resume` with an extended budget.

With `isolation=worktree`, the loop creates an isolated Git checkout, returns a branch/path handoff on completion, and never auto-merges into the source checkout. `cleanup` removes the worktree separately and leaves the branch for review. By default a dirty source checkout is rejected because uncommitted changes are not part of the new worktree.

`start_process` also accepts an optional label and `task_id`, allowing long builds/dev servers to appear as durable operations associated with the persistent task.

Projects can override the auto-discovered verification recipe with `.local-coder/verification.json`:

```json
{
  "version": 1,
  "quick": ["npm run build"],
  "full": [
    { "label": "build", "command": "npm run build", "timeout_seconds": 180 },
    { "label": "tests", "command": "npm test", "timeout_seconds": 600 }
  ]
}
```

### External delegation

| Tool | Description |
|------|-------------|
| `subagent` | Run/manage an explicitly configured external model-capable runner, with optional Git-worktree isolation. It does **not** reuse the parent ChatGPT subscription. |
| `delegate_status` | Detect supported Claude, Codex, Grok, and OpenCode CLIs without launching them. |

### Claude Code ↔ MCP mapping

| Claude Code | This server |
|-------------|-------------|
| `Read` | `read_text_file` |
| `Write` | `write_file` |
| `Edit` / `MultiEdit` | `edit_file` / `multi_edit` |
| `Glob` / `Grep` / `LS` | `glob` / `grep` / `list_directory` |
| `Bash` | `run_command` |
| — | `apply_patch`, `git_*`, `project_context` |

## Configuration reference

Copy `.env.example` → `.env`:

```env
PORT=3000
HOST=127.0.0.1
MCP_TOKEN=                      # generate one — see below
WORKSPACE_PATH=/Users/you/Projects/my-app
CHATGPT_AUTO_APPROVE=true
LOCAL_CODER_TUI=auto
SHELL_TIMEOUT=300
GIT_TIMEOUT_MS=300000
MCP_SESSION_RECOVERY=true
MCP_SHELL_PERSIST_CWD=0
MCP_JSON_RESPONSE=false
MCP_SSE_KEEPALIVE_MS=10000
ADMIN_PORT=3011

# OpenAI Secure Tunnel (optional)
OPENAI_TUNNEL_ID=
OPENAI_TUNNEL_API_KEY=
```

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKSPACE_PATH` | `cwd` | **Your project root** (like `cd` before `claude`). Auto-loads `CLAUDE.md` / `AGENTS.md` into MCP instructions |
| `HOST` | `127.0.0.1` | Bind address. Keep as-is — `0.0.0.0` exposes the shell to your whole LAN |
| `MCP_TOKEN` | *(empty)* | Secret in the endpoint path: `/mcp/<token>`. Empty = **no auth**. Generate: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` |
| `ADMIN_PORT` | `3001` | [Administration interface](#administration-interface) port (localhost-only, always on). Change it if something else uses 3001 — Docker Desktop often does |
| `ADMIN_TOKEN` | *(empty)* | Bearer token for the Admin UI. Empty = loopback check only |
| `CHATGPT_AUTO_APPROVE` | `true` | Tool annotations to reduce ChatGPT popups |
| `LOCAL_CODER_TUI` | `auto` | `auto` uses the clean dashboard only in an interactive TTY; `off` keeps scrolling logs; `on` requests TUI when stdout is a TTY |
| `MCP_SESSION_RECOVERY` | `true` | Auto-recover stale sessions after restart |
| `MCP_SESSION_TTL_MS` | `7200000` | Idle live-session retention (2 hours by default). Expired session IDs can still be recovered on demand instead of being retained all day |
| `MCP_CLOSED_SESSION_TTL_MS` | `900000` | Closed-transport retention (15 minutes by default) before cleanup |
| `MCP_SESSION_MAX_RETAINED` | `32` | Hard cap on retained MCP session/server objects. Old closed/idle sessions are evicted first; stale IDs can still auto-recover on demand |
| `MCP_SHELL_PERSIST_CWD` | `false` | Persist shell cwd across transport recreation. Off by default because ChatGPT may create a fresh MCP transport per tool call; explicit `working_directory` is safer |
| `MCP_JSON_RESPONSE` | `false` | Keep `false` for SSE tool responses with heartbeat frames. Set `true` only as a compatibility fallback for clients that require one JSON response at the end |
| `MCP_SSE_KEEPALIVE_MS` | `10000` | SSE heartbeat interval for long MCP calls. The server clamps this to 1–60 seconds |
| `SHELL_TIMEOUT` | `300` | Default timeout for synchronous `run_command` / `run_commands_parallel` calls, clamped to 5–3600 seconds. Both support per-call overrides; prefer `start_process` for very long or continuous jobs |
| `GIT_TIMEOUT_MS` | `300000` | Default timeout for native Git tools, clamped to 5 seconds–10 minutes |
| `MCP_AGENT_TASK_STATE_DIR` | `.mcp-state/agent-tasks` | Durable regular-ChatGPT coding-task/plan state |
| `MCP_OPERATION_STATE_DIR` | `.mcp-state/operations` | Durable background-operation history and bounded output tails |
| `MCP_EDIT_TRANSACTION_STATE_DIR` | `.mcp-state/edit-transactions` | Durable transaction metadata and baseline snapshots for transaction-aware edits |
| `MCP_EDIT_TRANSACTION_MAX_FILE_BYTES` | `16777216` | Per-file baseline snapshot limit for edit transactions |
| `MCP_EDIT_TRANSACTION_MAX_TOTAL_BYTES` | `67108864` | Total baseline snapshot limit for one edit transaction |
| `MCP_CODING_LOOP_STATE_DIR` | `.mcp-state/coding-loops` | Durable coding-loop context, retry, phase, isolation, and verification-attempt state |
| `MCP_CONTEXT_CAPSULE_STATE_DIR` | `.mcp-state/context-capsules` | Durable bounded semantic + live machine-state handoff used when ChatGPT conversation context is lost |
| `MCP_CONTEXT_CAPSULE_TOOL_CALLS` | `12` | Tool-call budget between automatic machine-state snapshots; clamped to 4–100 |
| `MCP_CONTEXT_CAPSULE_RESULT_BYTES` | `65536` | Accumulated tool-result byte budget between automatic machine-state snapshots; clamped to 8 KiB–1 MiB |
| `MCP_CONTEXT_CAPSULE_ROLLOVER_CYCLES` | `3` | Consecutive context-budget cycles before Local ChatGPT Plus recommends a safe fresh-chat rollover; clamped to 2–20 |
| `MCP_CODING_LOOP_WORKTREE_ROOT` | OS temp directory | Optional root for `coding_loop isolation=worktree`; restricted profiles should choose a path inside an allowed root |
| `MCP_RESULT_STATE_DIR` | `.mcp-state/results` | Durable bounded storage for oversized textual tool output referenced by result handles |
| `MCP_PARALLEL_BATCH_STATE_DIR` | `.mcp-state/parallel-batches` | Crash-resumable per-member state for parallel command batches |
| `MCP_IDEMPOTENCY_STATE_DIR` | `.mcp-state/idempotency` | Persistence for idempotency keys used to avoid duplicate side effects on retried shell work |
| `MCP_PROJECT_REGISTRY_PATH` | `.mcp-state/projects.json` | Recent-project registry and aliases. Git remote identity reconciles moved repos; there is no process-global active project |
| `MCP_VERIFICATION_CACHE_STATE_DIR` | `.mcp-state/verification-cache` | Optional successful-verification cache storage |
| `MCP_VERIFICATION_CACHE_TTL_SECONDS` | `300` | Maximum age of a cached verification success; cache keys include Git HEAD and the dirty/untracked worktree state |
| `MCP_TEXT_CACHE_MAX_BYTES` | `33554432` | Total estimated heap budget for cached text-file contents (32 MiB); least-recently-used entries are evicted under pressure |
| `MCP_TEXT_CACHE_MAX_ENTRY_BYTES` | `2097152` | Maximum estimated heap retained by one cached text file (2 MiB); larger files are readable but are not retained |
| `MCP_TEXT_CACHE_MAX_ENTRIES` | `128` | Secondary entry-count ceiling for the in-memory text cache |
| `MCP_RUNTIME_IDENTITY_PATH` | workspace-scoped `.mcp-state/runtime-identities/<hash>.json` | Optional explicit override for the real server-run identity/schema record used to detect connector schema drift |
| `MCP_EPHEMERAL_STATE_RETENTION_DAYS` | `30` | Startup retention window for result/batch/idempotency/verification-cache records |
| `MCP_STALE_STATE_HOURS` | `24` | Age threshold used by `agent_status(mode="doctor")` when reporting stale resumable tasks/loops/transactions; Doctor never deletes them automatically |
| `PERMISSIONS_CONFIG` | `profiles/permissions.json` | Optional permission-profile file (`open`, `workspace`, `read_only`, or `custom`). If unset and the default file is absent (e.g. fresh checkout), the server falls back to `open`; **if explicitly set to a missing file, startup fails closed** rather than silently running unrestricted. |
| `INBOUND_AUTH_MODE` | `token` | Inbound auth boundary. `token` = the `MCP_TOKEN` URL-path baseline. `oauth` = inbound OAuth 2.1 resource server (Bearer tokens, discovery, per-tool scopes); fails closed at startup on bad config. See [Inbound OAuth guide](INBOUND_OAUTH_GUIDE.md) |
| `INBOUND_OAUTH_ISSUER` | *(empty)* | **Required in `oauth` mode.** RFC 8414 issuer URL of the identity provider |
| `INBOUND_OAUTH_RESOURCE_URI` | *(empty)* | **Required in `oauth` mode.** External canonical MCP URL (tunnel endpoint + `/mcp`); must be the token audience |
| `INBOUND_OAUTH_ALLOWED_SUBJECTS` | *(empty)* | **Required in `oauth` mode.** Intended account `sub` value(s), semicolon-separated |
| `INBOUND_OAUTH_JWKS_URI` | *(empty)* | Optional JWKS URL override (otherwise discovered from the issuer) |
| `INBOUND_OAUTH_ALLOWED_ALGORITHMS` | `RS256;ES256` | Accepted JWT signature algorithms |
| `INBOUND_OAUTH_CLOCK_SKEW_SECONDS` | `30` | Clock-skew tolerance for `exp`/`nbf` |
| `INBOUND_OAUTH_JWKS_CACHE_TTL_MS` | `300000` | JWKS cache age; bounds signing-key rotation/revocation latency |
| `INBOUND_OAUTH_DISCOVERY_TIMEOUT_MS` | `10000` | Issuer metadata/JWKS fetch timeout |
| `INBOUND_OAUTH_RESOURCE_NAME` | `Local ChatGPT Plus MCP` | Name shown in protected-resource metadata |

> Variables already set in your shell **win over `.env`** (`dotenv` does not override). If a change to `.env` seems ignored, check `env | grep WORKSPACE_PATH` first.

> The default `open` permission profile provides full local access (subject to OS ACLs). `WORKSPACE_PATH` sets the default cwd; restricted permission profiles can turn configured roots into an application-level boundary.

> Long tool calls use Streamable HTTP/SSE by default and emit heartbeat comment frames every 10 seconds. Long-running work should still prefer `start_process` plus `process_status(wait_for="exit")` / `process_output(wait_for=...)` instead of `sleep` polling or keeping one tool call open for minutes.

> Direct upstream MCP proxies conservatively require write/unsafe-runtime permission regardless of remote `readOnlyHint` annotations. A native read-only integration can be treated differently only where explicitly implemented.

## Controller (`lcp`) lifecycle consistency *(2026-11-20)*

The `scripts/lcp` controller now keeps the stored access mode honest:

- **`lcp on`** with no mode change (server already ON in the same mode) is an
  idempotent no-op and only refreshes the stored mode.
- **`lcp on --mode <m>`** when the server is already running in a *different*
  mode refuses (nonzero exit) and tells you to run **`lcp mode <m>`**. The stored
  mode is never silently relabelled to disagree with the running profile.
- **Full/YOLO mode** still requires explicit confirmation and is never entered
  implicitly; `toggle` never enables Full.
- **`lcp off` fails closed**: it only reports OFF after both launchd jobs are
  unloaded **and** ports 3000 / 3001 / 8090 have stopped listening. On a partial
  stop it exits nonzero with `ERROR — OFF incomplete` and names the remaining
  listener/job, so `lcp off` can no longer claim success while something stays up.
- **`lcp status`** now reports the *stored* mode, the *actual* runtime mode read
  from the server health endpoint, and whether they agree (plus a pending-switch
  hint when they do not). Port 3001 is attributed to the MCP server process
  (normally the same pid) instead of being called unrelated.
- The **Projects Shortcut** now calls `lcp mode projects`, so it switches from an
  already-ON Workspace/Full deployment instead of just re-labelling it.

## Administration interface

A local web console ships with the server. It starts by default with `npm start` (same process, separate port); set `LOCAL_CODER_ADMIN_ENABLED=false` to disable it when Admin settings and OAuth callbacks are unnecessary.

```
http://127.0.0.1:3001/ui          # or your ADMIN_PORT
```

The exact URL is printed in the startup banner. Stopping the server stops the admin UI too (`Ctrl+C` in the launching terminal).

| Tab | What it does |
|-----|--------------|
| **Overview** | Live ChatGPT tool calls plus active project/machine workspaces, persistent agent plan/progress, coding loops, context capsules, background operation history/liveness, edit transactions, tunnel health, runtime/schema identity, per-tool p50/p95/result-volume/repeat telemetry, PID/MCP transports/workers, and upstream health |
| **MCP Servers** | Enable/disable upstream MCP servers, test connections, inspect their tools |
| **Import** | Pull existing MCP config from Cursor / Claude Code / OpenCode |
| **Activity** | Live tool-call log from ChatGPT (SSE stream) with a status banner (server/mode/roots/sessions/jobs/last-tool/tunnel), a separate **Running now** panel, friendly human descriptions, and structured sanitized expandable details |
| **Missions** | Task-first board over the persistent agent-task registry: plain-language goal, project, source, status, current step, last verified activity, blocked/"needs attention", and a **Copy handoff instructions** button for human-initiated ChatGPT-to-ChatGPT handoff via the shared mission id |
| **Project** | Preview the exact MCP instructions injected into ChatGPT each session |
| **Settings** | Read **and write** `.env` |
| **Raw status** | Raw JSON status dump |

This is the **hub** side of the project: upstream MCP servers are proxied through this one connector, so ChatGPT reaches their tools without being wired up separately. Configure them in `MCP_UPSTREAM_CONFIG` (default `profiles/mcp-upstream.json`).

> ⚠️ **Never expose this port through a tunnel** — only tunnel port 3000. The admin API writes `.env`, so reaching it means being able to change `WORKSPACE_PATH` or switch `MCP_TOKEN` off. It is protected by a loopback-only guard plus the optional `ADMIN_TOKEN`; set `ADMIN_TOKEN` when the Admin UI is enabled.

## Architecture

```
src/
├── index.ts                 # Express + MCP session manager
├── server-factory.ts        # Tool registration
├── lib/
│   ├── mcp-session-manager.ts   # Session recovery, TTL
│   ├── agent-task-store.ts      # Persistent structured coding plan state
│   ├── operation-store.ts       # Persistent background-operation history
│   ├── edit-transaction-store.ts # Durable transaction baselines + rollback
│   ├── coding-loop-store.ts      # Persistent coding-loop phases, attempts, context + worktree handoff
│   ├── context-capsule-store.ts  # Bounded semantic + machine-state recovery snapshots
│   ├── repository-intelligence.ts # Symbol/reference/impact intelligence
│   ├── project-inspection.ts    # Compact repository reconnaissance
│   ├── verification.ts          # Verification recipes + output compaction
│   ├── patch.ts                 # apply_patch engine
│   └── persistent-shell.ts      # Stateful shell
└── tools/
    ├── filesystem.ts        # filesystem/search/edit + batch reads
    ├── shell.ts             # shell + durable background operations
    ├── git.ts               # Git + worktree tools
    ├── agent-task.ts        # persistent structured plan state
    ├── agent-runtime.ts     # inspect_project + verify_project
    ├── repository-intelligence.ts # repo_intel
    ├── edit-transaction.ts  # transactional edit lifecycle
    ├── coding-loop.ts       # resumable Codex-like execution loop around regular ChatGPT
    ├── context-capsule.ts   # compact checkpoint/resume for lost ChatGPT context
    └── context.ts           # agent_status, project_context
```

- **Transport:** MCP Streamable HTTP — `/mcp/<MCP_TOKEN>` and `/<MCP_TOKEN>` (or `/mcp` and `/` when `MCP_TOKEN` is empty)
- **Transport session:** Streamable-HTTP transport objects are bounded and recoverable when a client presents a stale transport ID. They are not treated as durable ChatGPT chat/work ownership.
- **Output:** Structured JSON from every tool

## Development

```bash
npm run build          # compile TypeScript
npm test               # patch + tool unit tests
npm run test:smoke     # read-only pre-flight security smoke (see below)
npm run test:integration  # MCP bridge integration on random ports
npm run test:all       # full isolated suite (server boot, disposable dirs/ports)
npm run dev            # watch mode (tsx)
node scripts/test-mcp-session.mjs   # integration test (server must be running)
```

## Verification: local smoke vs live maintenance-window validation

`npm run build`, `npm test`, `npm run test:integration` and `npm run test:all`
all run **locally and isolated**: disposable temp state, random (non-production)
ports, no real `.env`, no Auth0, no public tunnel, no OS GUI prompts, and no real
launchd service. `npm run test:all` already boots the real server on ephemeral
ports with isolated env and asserts health/Admin/tools. These prove the code's
fail-closed behavior, **not** the deployed connection.

`npm run test:smoke` (`node scripts/smoke-security-check.mjs`) is a fast,
server-less pre-flight that asserts, at the module layer, that the security
surfaces actually fail closed:

| Surface | Smoke assertion |
|---------|-----------------|
| Auth0 token vs token-mode | `token` (or unset) is the default and requires nothing; `oauth` fails closed at startup without `issuer` / `resourceUri` / `allowedSubjects`; invalid `INBOUND_AUTH_MODE` rejected |
| Admin loopback isolation | non-loopback client `403`; `127.0.0.1` / `::1` / `::ffff:127.0.0.1` allowed; `ADMIN_TOKEN` wrong → `401` |
| Permission profile fail-closed | missing explicit `PERMISSIONS_CONFIG` throws; invalid profile/version rejected; `read_only` denies write/commands/unsafe runtimes |
| Path / symlink escape | `validatePath` rejects a symlink from inside roots to outside roots |
| Upstream allowlist | unlisted / hidden upstream tool never reaches the provider |
| Headless approval | operator denial short-circuits, is never cached; unbounded scope rejected (no OS dialog invoked) |
| Native PTY / LSP | `node-pty` spawn/signal smoke; language-server `--stdio` liveness — **skipped** when the binary is not installed |

### What the local checks do **not** prove (live-only)

Do not mark P0.5/P0.6 "complete" on local evidence alone. The following require a
**real operator/credentials inside an authorized maintenance window** and cannot
be simulated by the isolated suite:

- Real **Auth0** login + MFA + **consent**, and real audience-bound JWT acceptance
  from a live ChatGPT conversation against the deployed `oauth` mode.
- A real **Secure MCP Tunnel** end-to-end and its **reconnect** after an
  interrupted connection (not a localhost HTTP fetch).
- A real **macOS approval allow/deny dialog** (the smoke check injects a deny
  callback and never shows a GUI; an interactive AppleScript dialog cannot be
  exercised headlessly).
- A real **ChatGPT connector refresh / `tools/list`** against the live endpoint.

### Commands for a future authorized maintenance window

Run only after an authorized window is confirmed and with a **clean checkout /
built artifact**. Use disposable dirs and random ports; never let a test write to
production `3000/3001/8090`, `.env`, or `.mcp-state`.

```bash
# 0. Confirm no live service currently owns the checkouts before you start.
lcp status                       # authMode + profile + health; stored vs runtime
lsof -nP -iTCP:3000,3001,8090 -sTCP:LISTEN   # must be empty (or only the real managed job)

# 1. Local read-only / isolated verification (safe any time, no live resources)
npm run build
npm run test:smoke                 # fail-closed security pre-flight
npm run test:all                   # full isolated suite (spawns server on random ports)
npm run test:integration

# 2. LIVE-ONLY checks — require the authorized window + real credentials.
#    These are the P0.5/P0.6 items the isolated suite cannot cover:
lcp on                             # start the managed deployment in its real mode
lcp status                         # confirm oauth (or intended) mode + workspace profile
curl -fsS http://127.0.0.1:3000/health           # local health
# ChatGPT client: tag your connector, exercise Auth0 login/MFA/consent, run a
# tool call, confirm Admin loopback is NOT reachable through the tunnel, then
# interrupt the tunnel and observe reconnect — do not leave a public tunnel up.

# 3. Cleanup + post-window verification (never skip)
lcp off                            # unload both launchd jobs
sleep 2
lsof -nP -iTCP:3000,3001,8090 -sTCP:LISTEN   # must be empty
```

Record the raw evidence (commands, exit codes, log/`curl` output) for the
backlog entry; a `[INFERENCE]` label in the report is not evidence.

## Security details

The default `open` permission profile grants **full local access** through Local ChatGPT Plus — files, shell, Git, and configured runtimes. Only expose it through a tunnel you control. Never share your connector URL or tunnel API keys.

- Binds `127.0.0.1` only (`HOST`) — not reachable from your LAN. The tunnel connects to localhost, so it still works
- `MCP_TOKEN` guards the endpoint at `/mcp/<token>`; `/mcp` and `/` return 404. **Set it** — without it, anyone who learns your tunnel URL gets a shell
- The connector URL contains the token — treat it as a credential, and stop the tunnel when you are done
- Under the default `open` permission profile, `WORKSPACE_PATH` only sets the default cwd. Use `workspace`, `read_only`, or `custom` permission profiles when Local ChatGPT Plus itself should restrict paths/commands. This is application-level policy, not an OS sandbox
- The [Administration interface](#administration-interface) is enabled by default (disable with `LOCAL_CODER_ADMIN_ENABLED=false`) and can write `.env` — tunnel **only** port 3000, never `ADMIN_PORT`, and set `ADMIN_TOKEN`
- `.env` and secrets are gitignored
- Audit log: `.mcp-audit.log` (optional, configurable)
- Use on a trusted network / personal machine only

**Inbound OAuth:** with `INBOUND_AUTH_MODE=oauth` the MCP endpoints require a
valid, audience-bound Bearer token and enforce per-tool scopes; the tokenized
`MCP_TOKEN` route is removed (no bypass) and unauthenticated MCP calls receive
`401`/`403` with an RFC 6750 `WWW-Authenticate` challenge instead of `404`. The
server fails closed at startup if the OAuth configuration is missing/invalid.
OAuth authenticates the user; it does **not** sandbox shell commands. See the
[Inbound OAuth guide](INBOUND_OAUTH_GUIDE.md).

## Extended troubleshooting

| Problem | Fix |
|---------|-----|
| **"Error in message stream"** right after *"Looking for tools"* — **no server log** | You did **not tag the connector**. New chat → **+** → **More** → enable connector, or type **`@Local ChatGPT Plus`** in the message. Then retry. |
| **Resource not found** on tool call | Refresh connector + new chat and ensure the latest build is running. Durable task/loop/capsule recovery uses explicit IDs/workspaces rather than assuming one stable MCP transport per chat. |
| **Connection failed** | Check `npm start` + tunnel are both running. URL must be HTTPS. |
| **Permission popup every call** | Settings → Apps → set connector to *Ask before important changes*. Don't use popup "Always allow". |
| **Tool blocked by host safety** | Review the requested action and permissions; do not use a different tool merely to bypass a safety restriction. |
| **`stream canceled`** in tunnel log | Server/tunnel restarted mid-session → refresh connector, new chat. |
| **Long tool-heavy turn looks frozen / tunnel log shows HTTP 413** | A tool result exceeded the secure tunnel body limit. Local ChatGPT Plus rejects oversized results before transport; use `read_text_file` offset/limit, smaller base64 chunks, or a shallower tree/search. |
| **`JavaScript heap out of memory` after many hours/tool calls** | Run `agent_status(mode="doctor")` and inspect heap/cache pressure. Phase 5 bounds text/context caches and retained MCP/process/PTY/subagent/LSP state; on older builds restart after saving durable state, update, then re-test the long-run workload. |
| **Tunnel URL keeps changing** | Use a stable tunnel ID with a macOS-compatible tunnel client. |
| **Connector stuck "loading" forever when you click Create** | Make sure you are on the latest build (`npm run build`) — older builds deadlocked on the SSE stream and never answered `tools/list`. Also confirm the URL includes `/mcp/<MCP_TOKEN>`. |
| **404 on the connector URL** | You omitted the token. Use `https://<tunnel>/mcp/<MCP_TOKEN>`, not `/mcp`. |
| **cloudflared never prints "Registered tunnel connection"** | Network blocks port 7844. `--protocol http2` will not help (same port). Use Pinggy — Option C. |
| **`EADDRINUSE` on 3001 at startup** | Something else owns the admin port (often Docker Desktop). Set `ADMIN_PORT=3011`. |
| **`.env` changes seem ignored** | A shell variable of the same name overrides it. Check `env \| grep WORKSPACE_PATH`. |
| **`npm test` reports `spawn bash ENOENT`** | Inspect shell availability, command paths, and test logs. Do not delete `.mcp-state` indiscriminately: it may contain resumable tasks, coding loops, and transactions. |
| **Access denied** | Wrong path or OS permissions on that file. |
| **git not found** | Install [Git](https://git-scm.com). |

See also [AGENTS.md](../AGENTS.md) for agent onboarding and `apply_patch` format.