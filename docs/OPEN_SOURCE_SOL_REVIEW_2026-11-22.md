# Independent security review — OpenAI Sol 5.6 xhigh — 2026-11-22

## Runner diagnosis and reproducible invocation

The initial OMP invocation blocked on stdin because it inherited an unclosed pipe. A second command requested unsupported tools. The first correctly configured comprehensive request used a 240-second deadline and was aborted at that deadline. A minimal `openai-codex/gpt-5.6-sol --thinking xhigh --no-tools` probe with `</dev/null` succeeded (`READY`, exit 0).

The comprehensive review succeeded (exit 0) on an isolated read-only Git worktree after using only `read,grep,glob` tools, `--no-session --no-extensions --no-skills --no-context-files`, `</dev/null`, `--max-time 900` and `--max-cost 5`. It inspected source on the branch based on `15d80e2`, not the later remediation commits. No secrets, home configuration or running services were provided to the reviewer.

## Prioritized findings and implementation disposition

| Finding | Evidence and prerequisite | Source-level disposition |
|---|---|---|
| **P0** Token mode without token may expose command execution when MCP port is reachable | `src/index.ts`, `src/lib/permissions.ts`; depends on a reachable endpoint with no secret | Added startup refusal for blank token outside explicit loopback-only test fixtures; disabled broad CORS; changed fresh-install permission fallback to `workspace` and Admin default to disabled. Note that allowing shell commands is never an OS sandbox. |
| **P0** Admin access and upstream config disclosure | `src/admin/server.ts`, `src/admin/routes.ts` and `src/lib/mcp-upstream-config.ts`; attacker must reach Admin on loopback or obtain Admin session | Admin now requires nonempty `ADMIN_TOKEN`, browser login with HttpOnly/SameSite cookie and CSRF tokens, explicit Host/Origin guard and response headers. Upstream headers/env/URL/argv/commands are masked in config responses; blank placeholders preserve existing values on edits. |
| **P1** Imported enabled MCP config could launch stdio executable at discovery | `src/lib/mcp-upstream-config.ts`, `src/lib/mcp-upstream-manager.ts`; requires operator import of untrusted project file | All imported entries forced `enabled:false`, `expose:none` regardless source/import option, and stdio transport requires unsafe-runtime permission **before spawn**. Added a synthetic non-execution regression. |
| **P1** Raw commands/stdout/stderr in durable operation state/Admin | `src/lib/operation-store.ts`, `src/tools/shell.ts`, `src/admin/routes.ts` | Durable operation history replaces raw command/output/error fields with fixed metadata-only markers; legacy indexes are redacted when read, and Admin process/worker views mask command and objective fields. Live authorized `process_output` still provides output, so do not run untrusted programs with secrets in their environment. |
| **Publication blocker** Real operator-specific file paths and tunnel/IdP identifiers in tracked reports and controller defaults | `scripts/lcp`, `profiles/mcp-upstream.json`, historical deployment markdown | Replaced operator-specific source defaults, disabled optional provider entries, sanitized deployment reports and backlog examples. All older commits must stay private; publish a clean new Git root rather than exposing the original repository history. |

## Existing defenses independently confirmed

The Sol review found code-level enforcement of OAuth signature/issuer/audience/expiry/subject, per-tool scopes, session ownership and downgrade denial, and substantive Admin Host/Origin checks. Those findings do **not** constitute a live penetration test.

## Further release gates

Use [release security checklist](OPEN_SOURCE_RELEASE_SECURITY.md), [execution plan](OPEN_SOURCE_RELEASE_WORKPLAN_2026-11-22.md) and [historical object audit](OPEN_SOURCE_HISTORY_AUDIT_2026-11-22.md). Validate public export, full macOS suite and externally managed tunnel/IdP with separately approved maintenance windows. Runtime/persistent secrets and any old private remote refs must not accompany the public release.

**Security note:** A static code audit cannot certify absolute absence of vulnerabilities. There was no live authorization bypass proof and no attempt to probe personal deployment infrastructure.
