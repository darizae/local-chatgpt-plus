# Provenance and security audit

**Audit date:** 2026-11-19  
**Project:** Local ChatGPT Plus (`local-chatgpt-plus`)

**Historical snapshot:** The npm/pnpm dual-manager instructions below describe
the 2026-11-19 state. As of 2026-11-23 the active checkout uses pnpm only:
`packageManager: pnpm@11.1.3`, `pnpm-lock.yaml`, and an approved-build policy in
`pnpm-workspace.yaml`. The npm lockfile and npm-only `allowScripts` field were
removed. See [CI gates](OPEN_SOURCE_CI_GATES.md) for the current install process.

## Scope and method

Reviewed all repository source, scripts, profiles, active documentation, package manifests, and files intended for the initial commit. Checks included inherited-name/URL/path searches, credential-pattern searches, binary/asset inventory, package lifecycle review, resolved dependency audits, installed-package license inventory, and manual review of entrypoints and security-sensitive configuration.

Dedicated scanners (`gitleaks`, `trufflehog`, and `detect-secrets`) were not installed. The secret result therefore combines repository-wide pattern scanning and manual inspection rather than an independent scanner database.

## Provenance classification

| Material | Classification | Decision |
|---|---|---|
| Inherited ChatGPT Local Coder source | Retain with attribution | MIT-licensed. Preserve the original hoangcoderr copyright and complete permission notice in `LICENSE`; identify the upstream project in `README.md`. |
| npm packages | Safe to retain under their package licenses | 118 installed package/version records declared licenses: 102 MIT, 8 ISC, 4 Apache-2.0, 2 BSD-2-Clause, and 2 BSD-3-Clause. No undeclared or proprietary package license was found. |
| Vercel `agent-desktop` / `agent-browser` integrations | Safe as optional external integrations | The repository contains adapters and documented upstream links, not vendored provider source or binaries. Providers remain separately installed and opt-in. |
| Admin UI source | Safe to retain | Text, HTML, CSS, and JavaScript only; no bundled fonts, images, or third-party UI library files were present. |
| Inherited remote icon URL | Unnecessary inherited material | Removed. It referenced a different GitHub account/project while the corresponding local PNG was missing, making provenance unclear and the UI test invalid. Text branding now has no external asset dependency. |
| `LOCAL_CODER_UPGRADE_TODO.md` | Retired after backlog migration (2026-11-21) | Initially retained as historical source in the 2026-11-19 audit; subsequently removed from the working tree at the owner's direction after all unfinished items were mapped to `MAINTENANCE_BACKLOG.md`. The original remains accessible in Git history, not as current operating guidance. |
| Legacy configuration identifiers | Retain for compatibility | Existing `LOCAL_CODER_*` environment variables, `.local-coder` / `.mcp-state` formats, and the inherited macOS browser-profile directory remain stable. Product, package, connector, UI, MCP client/server, temp-directory, and worktree-branch identities were rebranded. |

No vendored implementation, proprietary SDK, private endpoint, bundled certificate/key, font, image, or compiled binary was found in the source repository. Windows paths that remain in tests are cross-platform fixtures, not machine-specific configuration.

## Secret review

In the **2026-11-19 snapshot only**, no credential value or private key was detected in the intended commit. That historical conclusion does **not** cover all later commits, and later review found operator-specific paths, tenant/tunnel identifiers and deployment topology in tracked material. See [the 2026-11-22 full-history review](OPEN_SOURCE_HISTORY_AUDIT_2026-11-22.md) and [publication gates](OPEN_SOURCE_RELEASE_SECURITY.md). `.env.example` contains empty placeholders only. Runtime secrets and state are excluded by `.gitignore`, including `.env*` except `.env.example`, `.mcp-state`, OAuth state, audit logs, generated output, dependency trees, private-key/certificate extensions, and macOS metadata.

No credential rotation is required from the observed repository contents.

## Dependency and lifecycle review

Canonical npm installation is reproducible through `package-lock.json` and `npm ci`; pnpm remains supported through `pnpm-lock.yaml` and `pnpm install --frozen-lockfile`. npm 11 install-script approvals are pinned to the reviewed versions of `esbuild`, `fsevents`, and `node-pty`; pnpm allows the same native/build packages. The scripts are required for the TypeScript runner, macOS filesystem events, and PTY native binding.

The published `node-pty@1.1.0` macOS prebuild arrived with a non-executable `spawn-helper`, causing `posix_spawnp failed` despite a successful install. The project postinstall now adds only missing execute bits to that package-owned helper. Clean npm and pnpm installs both passed PTY, TypeScript/Python LSP, build, and tool-profile checks after this repair.

Safe compatible direct updates applied:

| Package | Before | After | Reason |
|---|---:|---:|---|
| `@modelcontextprotocol/sdk` | `^1.32.1` | `^1.32.2` | Current compatible patch; core MCP runtime. |
| `express` | `^5.2.1` | `^5.3.0` | Current compatible minor; MCP/Admin HTTP runtime. |
| `typescript-language-server` | `^6.0.0` | `^6.1.0` | Current compatible minor; retained LSP capability. |

`dotenv` 18 was not adopted because it is a major update without a demonstrated need. `typescript-lsp` intentionally remains the TypeScript 6 alias used as the language-server fallback, while TypeScript 7 remains the build compiler. Large optional packages (`node-pty`, Pyright, TypeScript language servers) are used by retained PTY/LSP functionality and were not removed.

Historical pnpm security overrides were removed after current npm and pnpm advisory data reported zero findings for the unforced compatible graph. The pnpm lock may retain compatible older resolutions until a normal dependency update; the overrides no longer force them. `npm dedupe --dry-run` proposed no changes.

Post-change advisory results on 2026-11-19:

| Audit | Result |
|---|---|
| `npm audit --json` | 0 total vulnerabilities |
| `npm audit --omit=dev --json` | 0 total vulnerabilities |
| `pnpm audit --json` | 0 vulnerabilities |

These are point-in-time registry results, not a guarantee against undisclosed vulnerabilities.

## Manual-review limitations

- Live browser/desktop providers, OAuth services, tunnel credentials, and GUI approval flows require separately installed software, credentials, or human interaction; no proprietary material was supplied for those paths.
- GitHub push remains intentionally blocked pending explicit user authorization.
