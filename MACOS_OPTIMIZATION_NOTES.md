# Local ChatGPT Plus macOS optimization implementation notes

This independent project derives from an inherited Repomix-based macOS edition of ChatGPT Local Coder. Historical statements below describe that supplied snapshot and do not claim identical behavior on Windows or Linux.

## Implemented

- Added macOS Claude Desktop and Cursor MCP import discovery; removed Windows AppData/ProgramData probing. Empty default upstream configuration replaces machine-specific disabled presets.
- Removed the Windows PowerShell launchers, the Windows ConPTY cleanup workaround, Windows process-tree/taskkill code, Windows executable and npm `.cmd` shim handling, and the Windows-only native `sky` integration from `node_repl`. The stateful JavaScript REPL and POSIX shell, process group, PTY, Git, recovery, LSP, MCP bridge, and browser MCP tools remain.
- Added an AppleScript confirmation dialog for sensitive browser/desktop MCP actions on interactive macOS sessions. Unsupported or headless invocation fails closed. The unreachable native **Windows Codex Computer Use plugin** integration, its Admin controls/API, and its auto-injected skill-path lookup have been removed; Vercel browser/desktop MCP and normal project/global skills remain available.
- Memoized per-session native-tool visibility and eliminated repeated synchronous override reads. Admin saves invalidate the cached overrides. Newly created sessions see changed Admin settings; manual edits to `profiles/tool-overrides.json` require a restart or explicit cache invalidation.
- Skipped registration functions for optional tool groups whose tools are hidden. Module imports are **still static** (not a full lazy-loading refactor), and internal LSP capabilities are not removed.
- Cached normalized local hooks configurations for five seconds, with in-flight read deduplication and immediate invalidation on Admin saves; manual on-disk edits are picked up after the cache interval or explicit invalidation. Blocking policy and fail-closed errors remain intact.
- Preserved the MCP text/structured envelope, but minified text JSON to reduce whitespace duplication without breaking text-only clients. Did **not** change the protocol payload contract.
- Reduced the dashboard's heavyweight runtime polling from once per second to once per five seconds, with overlapping request protection. The administration interface and the interactive TUI are dynamically imported only when enabled; disable Admin with `LOCAL_CODER_ADMIN_ENABLED=false` (default on); do not disable it if you need OAuth callbacks or Admin settings.
- Removed unused internal helpers and stale Windows live tests, replaced the nonfunctional hooks example with a working script, added a macOS shell launcher, and disabled unconsumed TypeScript declaration output.
- Removed additional verified-unreferenced helpers from process-tree, permissions, context-budget, delegation, audit metrics and session context; kept the live state and permission protections. Removed unreachable Windows plugin controls and stale ConPTY/PowerShell/Windows-path presentation references, retaining the historical upgrade checklist unchanged.
- Replaced whole-file project-memory and nested-import reads with bounded streaming. The parser preserves the root/user/rule priority, four-level imports, visited-path cycle handling, fenced imports, HTML-comment removal, line/byte limits, and truncation reporting. Rule-frontmatter discovery now streams rather than loading each entire rule file.
- Added `scripts/test-project-memory-bounded.mjs` to `npm test` with legacy-output comparisons, large root/import I/O assertions, and path-scoped rule exclusions; simplified redundant test-platform branches.

## Conservative cleanup follow-up (2026-11-19)

- The root README was shortened for onboarding; comprehensive functionality, configuration, security and troubleshooting instructions were retained in `docs/OPERATIONS.md`. `MAINTENANCE_BACKLOG.md` tracks outstanding validation and potential optimizations without removing advanced functionality.
- Removed misleading Admin UI statements and blanket deletion advice for `.mcp-state`; the latter can contain resumable state and must not be purged casually.
- Optimized `.claude/rules` path-scoped loading: read complete rule frontmatter and only the visible body prefix instead of whole multi-megabyte files. Preserved the established 4,000-character output cap and added large-file regression coverage.
- Fixed a pre-existing path-scoped rule matching issue: project-relative patterns such as `src/**` now match absolute selected project paths, while existing absolute-path matching remains a fallback.
- Fixed the MCP JSONC importer to ignore `//` and `/* */` markers inside quoted strings, with a regression in `scripts/test-mcp-upstream.mjs`.
- No native tools, advanced features, tool profiles, provider availability, state formats, or dependencies were intentionally removed in this follow-up.
- Local isolated transpilation and bounded-memory tests are **not** full TypeScript or macOS runtime validation; see the maintenance backlog.

## Validation and caveats

- Run `npm ci`, `npm run build`, `npm test`, `npm run test:integration` and `npm run test:all` on macOS with the supported Node.js version to validate runtime, permissions, and optional integrations.
- The bundled `scripts/test-macos-optimizations.mjs` covers config discovery, the direct spawn adapter, compact MCP text fallback, tool-profile snapshot behavior, and hook cache invalidation.
- Because the original snapshot contained no installed `node_modules` or compiled `dist`, static checks alone cannot establish startup time, bundle size, or runtime performance improvements.
- Optional dependencies (`node-pty`, language servers) remain installed to preserve exposed features; replacing them with lazily installed packages needs a separate packaging and compatibility test pass.
- macOS GUI approval needs an interactive logged-in desktop with `osascript`; browser MCP requires separately installed upstream programs.

## Snapshot-only validation boundary

This packed Markdown file is not an installed repository, so its embedded sources require extraction and dependency installation before a full TypeScript build/integration run. Checks performed during this editing pass and any environment-specific limitations should not be described as macOS runtime verification. The native tool catalog and current slim/full profiles are deliberately unchanged; live macOS approval, PTY, desktop/browser MCP and tunnel tests require a real Mac.

## Validation performed for this cleanup snapshot

The following checks were performed on the extracted Markdown source under **Linux, Node.js 22.16.0**, not a real Mac (the project requires Node.js 22.22.2 or later):

- **Passed:** all 95 embedded TypeScript source files were syntax-transpiled with the available TypeScript compiler (no parse diagnostics). The modified, dependency-free library subset (`project-memory`, `process-tree`, `permissions`, `context-budget`, `delegate-registry`, `audit-metrics`, `session-context`, `mcp-upstream-config`, and `skills-loader`) passed isolated strict type checking using preinstalled Node typings. This is not a complete project type check.
- **Passed:** all 49 JavaScript test/build scripts and the Admin UI JavaScript passed `node --check`.
- **Passed:** `node scripts/test-project-memory-bounded.mjs` on the transpiled snapshot. Its legacy comparison covers nested/circular imports, import-depth limits, failed imports, fenced imports, Unicode, HTML comments, line limits and byte truncation. Both 32 MiB root and imported files required no more than 16 KiB each of actual prefix-read I/O for the bounded fixture.
- **Passed:** `node scripts/test-tool-profile.mjs` (9/9). The native catalog remains 71 registered tools; the default slim profile remains 42.
- **Blocked, not passed:** `npm run build`, `npm test`, `npm run test:integration` could not compile without unbundled dependencies and Node type definitions. `node scripts/test-macos-optimizations.mjs` could not start because `zod` was not installed. Attempted `npm install` did not complete in this environment. Full integration, GUI approvals, PTY, browser/desktop MCP, and macOS runtime behavior remain unverified and must be tested with a supported macOS installation.

No tool schemas, registered tool names, dependency declarations, or advanced-capability entrypoints were intentionally changed.