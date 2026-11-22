# Open-source release hardening execution plan — 2026-11-22

**Status: IN PROGRESS — release remains BLOCKED.**
Base revision: `bbb5b7c`; live/main advanced to `e38e68b` after base. Changes remain in isolated worktrees until reviewed and integrated. Do not restart the installed MCP service, reconfigure the live IdP/tunnel, expose ports, or push a force-update.

## Safety contract

- Read source before edits, use standalone Git worktrees, keep existing uncommitted work intact.
- Redact discovered secrets and identifiers in every report: record object IDs, affected paths, category and severity, never actual values. Do not run live exploit probes.
- Do not treat `.gitignore` or a clean HEAD as evidence that old blobs are safe; scan all reachable refs including remote refs, and decide how to publish without sensitive history.
- A local commit is not a live deployment. Remote/public publication requires verified sanitized history and explicit review of branch protection and destructive-ref implications.

## Workstream ownership and gates

| Workstream | Owner | Isolated branch | Acceptance |
|---|---|---|---|
| Admin authentication, CSRF/Host/Origin, upstream secret redaction and regression tests | Primary agent | `review/oss-release-prep-20261122` | Tests show unauthorized writes fail; canary credentials absent from all Admin responses |
| History/secret inventory and publication strategy | Primary agent + SAIA reviewer | `agent/oss-secret-audit-20261122` | All Git refs/unique historical blobs scanned, findings redacted, no silent force push |
| Documentation hygiene and clean onboarding | SAIA DeepSeek agent | `agent/oss-doc-sanitize-20261122` | No operator-specific paths/hostnames in published docs; manual and agent steps documented |
| CI security gates and safe dependency review | SAIA DeepSeek agent | `agent/oss-ci-security-20261122` | CI runs isolated build/smoke/tests, secret scan and audit without credentials |
| Independent architecture and security review | OMP OpenAI Sol 5.6 xhigh | `review/oss-security-audit-20261122` | Bounded successful review with file/line evidence and follow-up triage |
| Integration, tests and commits | Primary agent | `review/oss-release-prep-20261122` | Merge reviewed commits, `npm run test:all`, integration and smoke pass, no secret disclosure |

## Known P0 blockers

1. Optional Admin authentication and lack of a browser-safe CSRF mechanism.
2. Admin config/diagnostics can include upstream header/env credential values.
3. Runtime defaults can expose a wide set of local resources and commands.
4. Private historical operational details and any possible historical secrets require complete-object scan and a clean publication strategy.
5. Full OAuth and tunnel reconnect/GUI validation requires a separately authorized maintenance window.

## Evidence ledger

- Prior isolated baseline: `npm ci`, build, full suite, smoke, MCP integration, 10-case Host/Origin and both npm dependency audits passed (zero reported advisories, not proof of zero flaws).
- OMP Sol 5.6 xhigh earlier timed out with `--max-time 240` and no text; logs showed one provider request aborted by the session deadline. Earlier attempt also stalled on piped stdin due to failing to close stdin, and a second used unsupported tool names. Those are invocation problems; probe the model independently before attributing to model availability.
- SAIA Qwen fallback returned several supported issues plus false positives; evidence is summarized in `docs/OPEN_SOURCE_RELEASE_SECURITY.md`.

## Exit criteria

- Every issue closed or explicitly accepted with test evidence.
- No real credential or sensitive personal asset in any commit/tree/ref intended for public exposure; if uncertain, keep repository private.
- Public deployment hardening tested on a disposable OS account/VM, not this operator's live Mac.
- Security policy and setup instructions reflect actual choices, not private deployment details.
