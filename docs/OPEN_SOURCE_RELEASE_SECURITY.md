# Open-source release: security acceptance gates

**Review baseline:** 2026-11-22 source hardening integrated on an isolated release branch, after read-only OMP Sol 5.6 xhigh review. **Publication is still blocked** by live acceptance and public-snapshot/historical privacy gates. A passing build or audit does not prove the deployed runtime, public Git history, tunnel, IdP or host is safe. No live deployment is changed by this document.

## Threat model

An attacker might be a malicious website opened in the operator's browser, an internet client that reaches an incorrectly exposed MCP port, a malicious MCP server/skill/subagent, or an authorized agent tricked by untrusted repository text. The exposed assets include local files, command execution under the macOS user, OAuth access tokens, tunnel credentials, upstream credentials, audit history, and the Admin control plane.

### P0 — block publication and public deployment

- [ ] **Review all Admin routes and fail closed.** The Admin API is a separate loopback control plane. `src/admin/localhost-guard.ts` previously accepted localhost socket peers even with attacker-chosen Host/Origin, and `ADMIN_TOKEN` remains optional. Add Host/Origin checks and regression tests, then provide an authenticated browser-compatible Admin session model, CSRF protection and strict cookie/session policy (or disable Admin entirely for a public preset). Mutations include permissions, hooks, subagents, upstream MCP, tools, imports, and worker cancellation. Do not consider the new request-origin checks a substitute for authentication.
- [ ] **Stop config/diagnostic disclosure.** `src/admin/routes.ts` returns the full upstream config via `manager.getConfig()` in multiple responses; upstream entries allow `env` and `headers`, which can contain credentials. Inventory `/api/upstream`, `/health`, `/api/runtime`, activity/SSE, worker records, instructions preview, configuration routes and error bodies; redact secret-valued fields recursively at the server, not only in the UI. Write synthetic-canary tests against **every** route.
- [ ] **Require safe public defaults.** `src/lib/permissions.ts` intentionally defaults to `open`. `WORKSPACE_PATH` and permissions profile are **not an OS sandbox** for shell subprocesses. A public preset must use an explicitly configured workspace profile, opt-in commands/unsafe runtimes, Admin disabled until protected, and a nonempty secret or valid OAuth. Avoid altering existing users' running deployments without a migration plan.
- [ ] **Audit Git history and entire publication set for secrets and operational identifiers.** Review all refs and unreachable objects, prior commit messages, deleted files, screenshots, source maps, documentation, CI logs and releases with a dedicated secret scanner and manual checks. Run scans locally without uploading private secrets to a third-party service. A cleaned current HEAD **does not clean history**. Rotate any secret ever exposed and rebuild the Git history before opening the repository if necessary.
- [ ] **Re-run OAuth/tunnel and permission isolation tests in a disposable environment.** Inbound JWT issuer/audience/subject/scopes and OAuth session recovery have hermetic tests, but real tunnel reconnect and consent remain a controlled live-validation gate. Ensure OAuth resource discovery and per-tool authorization fail closed; ensure Admin port is never tunneled. Validate all HTTP verbs, CORS and session ownership.
- [ ] **Retest source and dependency supply chain.** `npm ci`, `npm run build`, `npm test`, `npm run test:integration`, `npm run test:smoke`, production and full dependency audits, lockfile hash, package script provenance, license attribution and CI checks. Record exact SHA/date/tool versions and investigate advisories; zero current advisories is not a guarantee.

### P1 — before calling the project hardened

- [ ] Isolate shell and untrusted subagents in an OS sandbox (dedicated user/VM/container), or explicitly document unrestricted same-user permissions and require human opt-in.
- [ ] Limit what is returned via diagnostics: absolute home paths, usernames, tool arguments, model output, upstream errors and sensitive environment values.
- [ ] Test import of untrusted MCP configurations: executable commands, inherited environment, URLs, OAuth callbacks and tool exposure allowlists; add prompts warning users before enabling imported servers.
- [ ] Verify command/PTY process-tree cleanup, symlink/path traversal, rapid restart, interrupt/retry and checkpoint failure cases.
- [ ] Add release CI: typecheck, smoke, unit/integration matrix, secret scanning, lockfile/dependency scanning, and branch protection before public PRs are accepted.
- [ ] Validate a clean-room first install by a non-maintainer following [setup](OPEN_SOURCE_SETUP.md), including manual ChatGPT/IdP/tunnel steps.

### P2 — disclosure and documentation hygiene

- [ ] Keep README architecture diagrams conceptual and generated from actual auth/transport behavior. Never embed private hostnames, tunnel IDs, access tokens, workspace owners, login screenshots or IdP tenant identifiers.
- [ ] Maintain `SECURITY.md` with coordinated vulnerability disclosure, supported versions, hardening limitations and response policy.
- [ ] Record non-secret build/release provenance, privacy policy for local audit/telemetry and a maintenance cadence for external libraries/providers.

## Existing defenses (do not regress)

The source already has inbound OAuth signature/issuer/audience checks, per-tool capability scopes, fail-closed handling when an explicitly configured permission file is missing, token-path redaction in MCP request logs, loopback Admin binding, local audit sanitization, and synthetic security tests. These provide real defense in depth, **not** a guarantee of safe use with `open` permissions or unrestricted shell.

## Review evidence and limitations

The Admin Host/Origin guard, authenticated session/CSRF checks, synthetic-canary config redaction and explicit token-mode startup checks now have passing source-level fixtures. Re-check every other status/diagnostic response with canaries and verify the installed service separately; source fixes alone are not a guarantee of complete absence of disclosure. The earlier [security review](SECURITY_CODE_REVIEW_2026-11-21.md) and [maintenance backlog](../MAINTENANCE_BACKLOG.md) contain historical, version-specific test evidence; do not infer live status from those documents.

**Independent model-review disposition (2026-11-22):** The first OMP `openai-codex/gpt-5.6-sol` xhigh comprehensive run timed out; a corrected 900-second read-only invocation **completed successfully**, identifying the Admin, empty-token, unsafe-import and durable-state disclosure findings. [Full review and remediation matrix](OPEN_SOURCE_SOL_REVIEW_2026-11-22.md). An OMP `saia/qwen3-coder-next` fallback completed on the original isolated source baseline. Its supported observations were optional Admin token (source `src/admin/localhost-guard.ts`), unrestricted default permission profile (`src/lib/permissions.ts`), empty-token sample (`.env.example`) and broad MCP CORS (`src/index.ts`). These are risk characteristics under the stated preconditions, not confirmed remote exploits. The reviewer incorrectly claimed missing remote IP bypass (the guard already rejects it), assumed Express allows CORS by default (it does not), and proposed blocking OAuth callback redirects by Referer (not a sound substitute for OAuth state). We rejected those unsupported suggestions. A separate manual source audit identified the upstream config credential-response issue not mentioned in the fallback. Runtime permission fallback, Admin authentication and startup are now source-hardened in the isolated branch, but deployment migration, completeness of diagnostic redaction and an OS process sandbox remain separately documented limitations. Do not report model opinions as reproduced exploits.

For every unresolved finding, capture a file/line, preconditions, practical impact, proposed remediation and a fixture-based reproducer before marking it fixed.
