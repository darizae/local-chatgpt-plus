# Security Advisory Review — dated dependency + upstream exposure audit

- **Date / environment:** 2026-11-21 14:04 CET (initial read-only audit); **lockfile correction + re-validation 2026-11-21, worktree `agent/security-lock-audit-20261121`**
- **Runtime:** Node.js 26.13.0, npm 11.20.0, pnpm 11.1.3, macOS darwin arm64
- **Scope:** Initial audit read-only. **F1 corrected:** `pnpm-lock.yaml` regenerated via `pnpm install --lockfile-only --ignore-scripts` (no dependency install, no `package.json` change), then re-validated with `--frozen-lockfile` and both audits. All checks completed; none require `INCOMPLETE`.

## 1. Lockfile version/resolution verification (both lockfiles)

| Artifact | Present | lockfile version | `npm ci` / frozen-install status |
|---|---|---|---|
| `package-lock.json` | yes | lockfileVersion 3 (npm) | consistent with `package.json`; `npm ls` (no `node_modules` in worktree) reports only the expected "missing" for uninstalled top-level deps, no invalid/extraneous |
| `pnpm-lock.yaml` | yes | 9.0 | initially STALE (`--frozen-lockfile` exited 1); **now consistent** — regenerated, `pnpm install --frozen-lockfile --lockfile-only --ignore-scripts` exits **0** |

**Root cause of pnpm staleness:** `package.json` declares direct dependency `jose@^6.2.18` (used by `src/lib/inbound-oauth/verifier.ts`). `package-lock.json` resolves it as top-level `node_modules/jose@6.2.18` (integrity `sha512-doV4...`, `resolved https://registry.npmjs.org/jose/-/jose-6.2.18.tgz`). The `pnpm-lock.yaml` **importer section omits `jose` entirely**; only a transitive `jose@6.2.17` appears (pulled in by `@modelcontextprotocol/sdk`), shown at `pnpm-lock.yaml:586,895,1252`. Because the direct specifier is missing from the importer, `pnpm install --frozen-lockfile` fails with:

```
Failure reason: specifiers in the lockfile don't match specifiers in package.json:
* 1 dependencies were added: jose@^6.2.18
```

### F1 resolution — regenerated `pnpm-lock.yaml` (2026-11-21)

Ran in the isolated worktree (no dependency install, no `package.json`/`package-lock.json` change):

```bash
pnpm install --lockfile-only --ignore-scripts
```

Result: a **minimal, surgical diff — 8 insertions, 0 deletions, 0 other packages touched.** The importer gained the missing direct specifier, with the matching package and snapshot entries:

- `pnpm-lock.yaml` importer (`.dependencies`): `jose: specifier: ^6.2.18, version: 6.2.18`
- `packages` section: new `jose@6.2.18` with resolution integrity `sha512-doV4...` (identical to the npm `package-lock.json` `node_modules/jose@6.2.18` integrity)
- `snapshots` section: new `jose@6.2.18: {}`

No unrelated version upgrades occurred (transitive `jose@6.2.17` and all other pins unchanged). Validation:

```bash
pnpm install --frozen-lockfile --lockfile-only --ignore-scripts   # exit 0 (was exit 1)
pnpm audit --json                                                 # exit 0, 0 vulns (165 deps)
npm audit --package-lock-only --json                              # exit 0, 0 vulns (163 deps)
```

**Impact (resolved):** `--frozen-lockfile` is valid again and `jose@6.2.18` is now audited as a direct dependency. The prior transitive-only `jose@6.2.17` remains (SDK's own dependency range) alongside the direct `jose@6.2.18`; both are advisory-free.

## 2. MCP SDK pin confirmation

`@modelcontextprotocol/sdk` is locked at **1.32.2 in both lockfiles**:

- `package-lock.json:512` — `version 1.32.2`, resolved from `registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.32.2.tgz`, integrity `sha512-SWsVtH/0vULSQ...`
- `pnpm-lock.yaml` — importer `@modelcontextprotocol/sdk: 1.32.2(zod@4.6.7)`; package `@modelcontextprotocol/sdk@1.32.2`

`package.json` requests `^1.32.2`; both locks pin 1.32.2 (no drift in either lock). **Pass.**

## 3. Audit results (network OK) — re-run post-F1-correction 2026-11-21

### 3a. `npm audit --package-lock-only --json`
- **Exit code:** 0
- **Vulnerabilities:** 0 total (info 0 / low 0 / moderate 0 / high 0 / critical 0)
- **Scope:** 163 deps (prod 102, dev 61, optional 47, peer 0)
- Source: npm registry audit endpoint; unchanged from initial run (npm lock never had the drift).

### 3b. `pnpm audit --json`
- **Exit code:** 0
- **Vulnerabilities:** 0 total (all severities 0)
- **Scope:** 165 total deps (prod 103, dev 61, optional 47) — was 164 before F1; now includes direct `jose@6.2.18` as a prod dep.
- Source: pnpm audit (registry); re-run 2026-11-21 after regeneration.

### 3c. npm vs pnpm audit difference
Both auditors agree on severity counts (zero at every level). A **dependency-count discrepancy persists that is NOT the F1 drift**: npm reports 163 deps / prod 102; pnpm reports 165 deps / prod 103. It predates and postdates F1 (npm count unchanged by the fix) and reflects each engine's independent resolution/tree-counting of the same `package.json`, not a vulnerability or an omitted dependency in one lock. `--frozen-lockfile` passes on both engines. No severity-level discrepancy exists.

## 4. Nov 11 2026 MCP reference-server advisories — applicability vs configured upstreams

### 4a. The advisories (reference servers only — `modelcontextprotocol/servers`)

The **2026-11-11** MCP reference-servers security release (`v2.4.0`, tag published 2026-11-11T07:07:16Z) fixes six advisories across the **Filesystem, Git, and Fetch reference servers**. Source: official MCP blog "MCP Reference Server Security Update: Versions and Upgrade Steps" (2026-11-17) — https://modelcontextprotocol.info/blog/reference-servers-security-update-2026-11 — plus the GitHub advisory pages linked from it.

| Package | GHSA | Severity | Affected | Fixed |
|---|---|---|---|---|
| `@modelcontextprotocol/server-filesystem` | GHSA-p9cv-8g75-4xcg | Moderate | < 2.3.0 and date 2025.1.14–2026.8.31 | 2.3.0 (symlink race on directory reads) |
| `@modelcontextprotocol/server-filesystem` | GHSA-7m4x-rv66-mxhh | Moderate | same range | 2.3.0 (move-source anchoring) |
| `mcp-server-git` (pip) | GHSA-6hqx-gqrx-c5r2 | **High** | < 2026.11.11 | 2026.11.11 (repo-controlled config, e.g. `core.fsmonitor`, runs during read-only tools) |
| `mcp-server-git` (pip) | GHSA-q74p-4wrc-q7w6 | Moderate | 2026.10.28–<2026.11.11 | 2026.11.11 (alternates / linked worktrees / symlink escapes) |
| `mcp-server-fetch` | GHSA-3rxj-6jhw-qfv7 | Low | 2026.10.10–<2026.11.11 | 2026.11.11 (fec0::/10 address classification) |
| `mcp-server-fetch` | GHSA-f9hh-cmx9-2f23 | Low | 0.6.1–<2026.11.11 | 2026.11.11 (robots.txt path normalization) |

A separate later (2026-11-18) release `v2.5.0` fixes eight further advisories (e.g. GHSA-rq2p-q7c4-6g27 filesystem symlink swap, GHSA-87qg-cmw8-jc5m git promisor/$GIT_CONFIG execution). Out of scope for this Nov-11 review but flagged for the 2026-11-18 window.

### 4b. This repo's configured upstreams — NOT the affected reference servers

`profiles/mcp-upstream.json` tracks **two** upstream stdio servers (both `expose: meta_only`, i.e. they expose metadata only, not MCP tool calls, through this host):

| id | name | command | args | version inspected |
|---|---|---|---|---|
| `vercel-agent-desktop` | Vercel agent-desktop (native UI) | `agent-desktop` | `mcp` | **agent-desktop@1.3.1** (global, Apache-2.0) |
| `vercel-agent-browser` | Vercel agent-browser (Chrome) | `agent-browser` | `mcp --tools all` | **agent-browser@0.43.0** (global; ships native `@agent-browser/cli-darwin-arm64` binary) |

Neither is a `modelcontextprotocol/servers` reference server. Direct dependency-ancestry check:

- `agent-desktop@1.3.1`: no npm `dependencies` (empty; native binary, Apache-2.0, Vercel Labs). Does **not** pull `@modelcontextprotocol/server-filesystem`, `mcp-server-git`, or `mcp-server-fetch`.
- `agent-browser@0.43.0`: npm `dependencies` empty; runtime is the prebuilt `@agent-browser/cli-darwin-arm64/bin/agent-browser` native binary. Does **not** pull any reference server.

**Nested-tool / non-applicability check (per assignment):** inspected the *actual* `command`/`args` in the tracked config — they launch the Vercel `agent-desktop` and `agent-browser` executables at `~/.nvm/versions/node/v26.13.0/bin/`, not `npx -y @modelcontextprotocol/...` and not `uvx mcp-server-git/.../fetch/...`. A code/config scan for `mcp-server-git`, `mcp-server-filesystem`, `mcp-server-fetch`, `npx -y @modelcontextprotocol`, and `uvx.*mcp-server` across `profiles`, `src`, `scripts`, and root config found **no launch sites**. Dependency ancestry of both configured binaries is empty (no transitive path into the affected npm/pip packages).

**Conclusion:** the six Nov-11 reference-server advisories are **not applicable** to the two CONFIGURED upstreams, because those upstreams are the Vercel native binaries with no reference-server ancestry and this host never activates a reference server. This is a *dependency-ancestry* conclusion, not a false "we don't use that" claim — but note the residual limit: `meta_only` exposure means these upstreams are not callable as MCP tools through this host today; their internal (native) behavior is outside this repo's dependency tree and is not audited here. If a future profile entry or nested tool adds `@modelcontextprotocol/server-filesystem`, `mcp-server-git`, or `mcp-server-fetch`, this review does NOT cover it and it must be re-pinned per §4a fixed versions before enablement.

## 5. npm install-script / supply-chain risk

- `package.json` has a root `"postinstall": "node scripts/fix-node-pty-permissions.mjs"` and an `"allowScripts"` allowlist: `esbuild@0.28.2`, `fsevents@2.3.3`, `node-pty@1.1.0`.
- The postinstall script (`scripts/fix-node-pty-permissions.mjs`) is reviewed and benign: non-Windows only, it `lstat`s the `node-pty` `spawn-helper` under `prebuilds/<platform>-<arch>` or `build/Release`, and `chmod`s its owner-exec bit if not already executable. It does not download, evaluate, or network anything. Low risk.
- `esbuild@0.28.2`, `fsevents@2.3.3`, `node-pty@1.1.0` are all `hasInstallScript`/`postinstall` packages; they are the only build-script packages and are explicitly whitelisted in both npm (`allowScripts`) and pnpm (`pnpm-workspace.yaml` `allowBuilds`: esbuild/fsevents/node-pty). No unlisted package has a build script.
- No lockfile tampering or integrity flag: every `resolved`+`integrity` pair in `package-lock.json` and `pnpm-lock.yaml` is present and internally consistent; the former `jose` importer gap (structural, not integrity-conflicting) is now resolved (§1).
- `engine-strict` not set in a tracked `.npmrc` (no `.npmrc` present at repo root), so Node engine constraints are advisory only.

## 6. Findings summary

| # | Severity | Finding | Action |
|---|---|---|---|
| F1 | **Low (hygiene / release-gate)** | `pnpm-lock.yaml` stale vs `package.json`: direct `jose@^6.2.18` missing from importers; `pnpm install --frozen-lockfile` exited 1. | **RESOLVED 2026-11-21** — regenerated lock-only; frozen install now exits 0; `jose@6.2.18` pinned as direct dep (see §1). |
| F2 | **Info (pass)** | `npm audit` 0 advisories (163 deps), exit 0. | None. |
| F3 | **Info (pass)** | `pnpm audit` 0 advisories (165 deps), exit 0 post-fix. Persisting npm/pnpm prod-count discrepancy (103 vs 102) is engine counting, not a vuln/omission — see §3c. | None. |
| F4 | **Info (pass)** | `@modelcontextprotocol/sdk` locked 1.32.2 in both lockfiles. | None. |
| F5 | **Info (pass)** | Nov-11 reference-server advisories not applicable to configured `agent-desktop`/`agent-browser` (Vercel native, no reference-server ancestry; host exposes them meta-only). | Re-review before adding any reference-server entry; see 2026-11-18 `v2.5.0` advisory set. |
| F6 | **Info (pass)** | npm install scripts allowlisted (esbuild/fsevents/node-pty); postinstall chmod benign. | None. |

## 7. Suggested upgrades — F1 adopted, no version upgrades

F1 was the only required change (structural, not advisory-driven) and is now adopted (regenerated pnpm lock; `jose@6.2.18` direct). No version upgrades were made: no advisory requires an update and both audit engines report zero. Optional future hygiene:

- When next bumping `@modelcontextprotocol/sdk`, prefer 1.32.2 (already current) and confirm both locks in the same commit.
- No reference-server pin is needed by this retarget; if one is ever added, pin `@modelcontextprotocol/server-filesystem@2.3.0`, `mcp-server-git==2026.11.11`, `mcp-server-fetch==2026.11.11` (note the 2026-11-18 `v2.5.0` fixes for the later window).

## 8. Advisory source URLs

- MCP reference-server security update (2026-11-17, lists all six GHSA + fixed versions): https://modelcontextprotocol.info/blog/reference-servers-security-update-2026-11
- GHSA-6hqx-gqrx-c5r2 (mcp-server-git, High): https://github.com/modelcontextprotocol/servers/security/advisories/GHSA-6hqx-gqrx-c5r2
- GHSA-q74p-4wrc-q7w6: https://github.com/modelcontextprotocol/servers/security/advisories/GHSA-q74p-4wrc-q7w6
- GHSA-p9cv-8g75-4xcg: https://github.com/modelcontextprotocol/servers/security/advisories/GHSA-p9cv-8g75-4xcg
- GHSA-7m4x-rv66-mxhh: https://github.com/modelcontextprotocol/servers/security/advisories/GHSA-7m4x-rv66-mxhh
- GHSA-3rxj-6jhw-qfv7: https://github.com/modelcontextprotocol/servers/security/advisories/GHSA-3rxj-6jhw-qfv7
- GHSA-f9hh-cmx9-2f23: https://github.com/modelcontextprotocol/servers/security/advisories/GHSA-f9hh-cmx9-2f23
- Reference servers advisory index: https://github.com/modelcontextprotocol/servers/security/advisories
- Release v2.4.0 (2026-11-11): https://github.com/modelcontextprotocol/servers/releases/tag/v2.4.0

## 9. Repro commands

```bash
node --version; npm --version; pnpm --version
# --- F1 correction (post-fix, all pass in this worktree) ---
pnpm install --lockfile-only --ignore-scripts                      # regen; minimal 8-line jose-only diff
pnpm install --frozen-lockfile --lockfile-only --ignore-scripts    # exit 0 — frozen install valid
pnpm audit --json                                                  # exit 0, 0 vulns (165 deps)
npm audit --package-lock-only --json                               # exit 0, 0 vulns (163 deps)
grep -n -A2 'jose:' pnpm-lock.yaml                                  # importer jose ^6.2.18 -> 6.2.18
# --- (pre-fix staleness repro, for reference: F1) ---
pnpm install --frozen-lockfile                                      # exited 1 before correction:
#   specifiers in the lockfile don't match specifiers in package.json: 1 deps added: jose@^6.2.18
```

## 10. Limitations

- No `node_modules` was created; `--lockfile-only` and `--ignore-scripts` meant no dependency install and no install-script execution occurred. Lockfile `integrity` fields are present and trusted as-is; no `npm ci` was run in the live checkout to avoid dependency changes.
- Both audits rely on the live registry (network OK, exit 0); results are point-in-time as of the re-run timestamp in §1. The npm-163 vs pnpm-165 dependency-count difference is an engine-counting artifact (see §3c), not an omitted dependency.
- The correction was validated against `package.json` in this isolated worktree only; the lock was not regenerated again after the validation runs, and no `package.json`/`package-lock.json` was modified.
- Vercel `agent-desktop`/`agent-browser` internals are native binaries not in this repo's dependency tree; their private behavior is not audited. The `meta_only` exposure means they are metadata-only through this host today.
- Advisory applicability is scoped to the **configured, tracked** `profiles/mcp-upstream.json` entries. Any future addition of a reference server invalidates §4b.
