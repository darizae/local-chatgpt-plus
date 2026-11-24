# Local ChatGPT Plus — public release backlog

**Last reviewed:** 2026-11-23. The original maintainer's private deployment logs and historical identifiers are intentionally not part of the public source history. This is the release-facing backlog; all checkboxes indicate evidence-based work remaining.

## Required before a public release

- [x] Inbound OAuth resource-server verification, subject/audience/scope checks (isolated fixtures).
- [x] Reject empty token-mode authentication outside explicit loopback-only automated fixtures.
- [x] Require Admin authentication; add HttpOnly SameSite session cookies, CSRF, Host/Origin controls and login throttling.
- [x] Mask upstream environment/header/command/URL values in Admin responses.
- [x] Require an explicit activation of imported MCP servers; block stdio transport spawn under restricted permissions.
- [x] Default new workspaces to `workspace` permission profile and disable Admin/auto-approval on fresh checkout.
- [x] Keep command/output tails out of durable operation history and provide metadata-only Admin status.
- [x] Offline HEAD credential tripwire, separate full private-history audit and clean-root publication candidate.
- [x] macOS isolated build, security smoke, integration and full regression test suites.
- [ ] Verify a clean checkout on another Mac and run an end-user manual setup following [setup](docs/OPEN_SOURCE_SETUP.md).
- [ ] Carry out a controlled, authorized real Secure MCP Tunnel + IdP consent/reconnect maintenance-window acceptance test; isolated tests are not live deployment proof.
- [ ] Independent current-version secret scanner plus manual final inspection of publication snapshot including non-text assets and provider IDs.
- [ ] Turn on and validate the GitHub security CI/branch protections **for the intended new public repository only**; no automatic change to current private repository.
- [ ] Confirm disclosure contacts, release version/tag and dependency support/ownership.
- [ ] Decide a dedicated low-privilege OS account/VM isolation plan for untrusted projects. A `workspace` permission profile **does not sandbox shell subprocesses**.

## Highest-priority connector compatibility blocker

- [ ] **Deliver native MCP ImageContent to the ChatGPT model.** A view_image tool can produce valid PNG image blocks in native MCP tests while a connected tool adapter exposes only structured path/MIME/byte metadata, not pixels. The defect is not specific to one desktop or Linux runtime. Implement or coordinate connector-level preservation of image blocks and verify actual model-visible pixels through the hosted connector with a synthetic, recognizable multicolor fixture. A separate base64-read-and-forward workaround is **not** acceptance of view_image. Add regression coverage for image bytes, MIME types, file-size limits, authorization denial, and transport failures without publishing real screenshots, personal identifiers, or raw image artifacts.

## VPS self-service operations

- [x] Reproduce rolling SAIA quota exhaustion; remove both rolling admission quotas (including legacy policy fields), raise per-job cost/runtime, improve result/prompt capacity, allow dirty parent checkouts with pinned committed baseline and keep typed diagnostics.
- [x] Implement a socket-activated fixed-operation maintenance bridge and compiled artifact identity checks, with hermetic tests; no general root execution.
- [ ] Complete one-time authorized host bootstrap of the tunnel reliability drop-ins, root-owned queue/broker artifacts, quota-free SAIA queue, updated native launcher profile, writable workspace caches and maintenance socket. Verify actual SAIA model execution, a fresh MCP tool call after restart, PIDs, artifact commit and phone disconnect.
- [ ] Verify the isolated model queue cannot reach the maintenance socket and the restart broker rejects extra operations under the live systemd sandbox.
- [ ] Add approved/signed release handling for updates to privileged host components themselves, so normal application deployments remain self-service without giving the MCP runtime general root authority.

## VPS repository development friction audit

- [x] Redirect npm/pnpm/pip/uv/browser caches into a writable workspace-local directory in the reviewed migration. Live install still pending.
- [ ] Verify fresh installs with npm, pnpm and uv/pip inside the real service; provision a pinned pnpm executable (not currently on the MCP PATH) and browser runtime/dependencies.
- [ ] Make Git identity setup and repo onboarding routine: standard commits currently require an identity, private fetch/clone may need scoped credentials, and push broker only accepts pre-registered origin/feature branches. Preserve protected branch/secret checks; add an owner-approved repo registration/PR workflow.
- [ ] Add isolated rootless container/build/test capability for Docker/Compose workflows; access to the existing rootful Docker socket is denied. Do not grant arbitrary host-root-equivalent Docker access.
- [ ] Measure and tune MCP/worker cgroup resource ceilings (MCP 640 MiB RAM, one CPU, 128 tasks; worker 1.5 GiB RAM, one CPU, 128 tasks); distinguish memory/CPU exhaustion from application errors and avoid imposing arbitrary limits on normal repo builds.
- [ ] Provide structured, scoped alternatives for blocked interactive PTY/REPL/browser tools and ordinary cleanup commands; raw command-text deny regexes produce false positives and unrestricted runtimes are disabled. Keep the actual OS boundary and credential isolation intact.
- [ ] Add durable detached build/deploy jobs across MCP restarts, richer broker status/resume for model jobs, and a provider-credential-isolated private Git fetch path. The MCP connection and host-side runtime remain different failure domains.
- [ ] Validate arbitrary registered project layouts (nested repositories and worktrees), explicit uncommitted-change snapshots, bounded parallel workers and complete model artifact retrieval; native queue currently accepts direct named repositories and uses committed HEAD only.
- [ ] Audit current host privileges with the authorized operator, then implement reusable, scoped maintenance operations for routine service/container/package setup instead of repeated manual intervention.

See [VPS repository development audit](docs/VPS_DEV_FRICTION.md) for measured live evidence and priorities.

## Follow-up engineering work

- [x] Add opt-in versioned authenticated encryption for upstream OAuth state, key-file permission enforcement and explicit legacy migration consent; synthetic wrong-key/tamper and plaintext canary tests.
- [x] Minimize inherited external-subagent environment instead of forwarding the MCP process environment wholesale; add synthetic credential noninheritance tests.
- [ ] Provide OS-backed macOS secret storage and transactional fleet-wide key recovery/rotation; staged per-store rewrapping is available with operator-managed previous key, and existing installations remain plaintext until configured.
- [ ] Implement provenance-aware handling of persistent agent notes and untrusted MCP/GitHub/tool content, and independently enforced high-risk operation approvals. Content filtering alone is insufficient.
- [ ] Add OS-level isolation for untrusted subprocesses and enforce independent network/path/Git publishing policy; a worktree is not a sandbox.

- [ ] Improve safe retry/cancellation and crash/reconnect coverage.
- [ ] Browser/Desktop provider permission review and approval parity.
- [ ] macOS login/logout, `launchd` and offline availability matrix.
- [ ] More extensive Admin XSS/status/diagnostic canary coverage.
- [ ] Automated dependency and vulnerability review cadence.
- [ ] Manual/agent-assisted setup verification for tunnel providers.
- [ ] Optional billing/analytics integration only after an independent review of credential isolation.

See [security release gates](docs/OPEN_SOURCE_RELEASE_SECURITY.md), [Sol review](docs/OPEN_SOURCE_SOL_REVIEW_2026-11-22.md), [Security policy](SECURITY.md) and [install guide](docs/OPEN_SOURCE_SETUP.md).
