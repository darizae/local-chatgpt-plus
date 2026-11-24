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
- [x] Complete one-time authorized host bootstrap of the tunnel reliability drop-ins, root-owned queue/broker artifacts, quota-free SAIA queue, updated native launcher profile, writable workspace caches and maintenance socket. Live model jobs completed, including a dirty parent; detached restart changed both service PIDs and a fresh MCP call verified the compiled commit.
- [ ] Physically verify phone ON/OFF and Tailscale disconnect behavior during a separate operator window.
- [x] Verify effective model-worker inaccessible-path configuration for the maintenance socket; live maintenance broker rejected an arbitrary execute request.
- [ ] Independently probe the model worker mount namespace to verify socket inaccessibility without executing model-supplied privileged commands.
- [ ] Add approved/signed release handling for updates to privileged host components themselves, so normal application deployments remain self-service without giving the MCP runtime general root authority.

## VPS repository development friction audit

- [x] Install pinned pnpm 11.1.3, Playwright 1.65.1 and Chromium in writable VPS workspace caches through the live connector; browser smoke rendered a test page successfully. Add automatic cache/PATH/Git identity configuration to migration.
- [x] Implement owner-approved normal non-force pushes from any branch and dirty checkouts, no arbitrary binary/size/file-count publication bans, account credential fallback for new repositories, authenticated fetch and workspace Git identity. Live credential-isolated broker replaced; new private repositories fetched, main and dirty-worktree dry-runs accepted, authorized branch pushes verified.
- [x] Prepare dedicated rootless Docker daemon, local agent socket proxy and per-project bind-mount ACL helper. Installed and verified actual rootless image pulls, builds, Compose execution, named volumes, workspace bind mounts, and isolated inter-container HTTP. Existing rootful containers preserved.
- [x] Remove arbitrary CPU, RAM and task ceilings for MCP and model worker in reviewed drop-ins; retain physical host limits and credential boundaries. Effective running cgroup limits verified after installation.
- [x] Implement separately opted-in workspace PTY and subprocess REPL, explicit configured upstream tools, and removal of legacy local Git/recursive-cleanup command regexes during authorized bootstrap. Keep in-process unrestricted REPL and host-wide privileged operations disabled under the custom profile.
- [x] Authorized bootstrap, effective resource limits, private fetch and main/dirty push dry-runs, PTY and subprocess REPL, account credential provisioning and rootless Docker/Compose smoke verified. GitHub permissions remain authoritative.
- [x] Add credential-isolated Git LFS fetch; verify seven materialized media objects and SHA-256 integrity in a private repository.
- [ ] Verify Git LFS upload preflight and multi-commit LFS upload coverage; current helper operates on committed HEAD.
- [ ] Investigate Docker attach-stream stdout through the local socket proxy. Detached create/start/wait/logs and Compose are verified; attached output was not reliable.
- [ ] Verify an actual enabled upstream MCP call. Upstream capability is enabled but the existing host has no enabled upstream server; do not activate disabled UI providers without reviewing configuration.
- [ ] Verify browser screenshots are returned as native model-visible MCP image content; working Chromium does not fix the hosted adapter image issue.
- [x] Implement independent durable background process supervisor, existing process tool integration, task execution status, private bounded output spool and restart-recovery integration test using separate MCP server processes.
- [x] Prepare phased administrator handoff, read-only preflight, Docker/Compose smoke script, and dedicated GitHub account public-key generation and verified activation.
- [x] Live acceptance: start a durable process, restart the MCP/tunnel, reconnect with same ID/PID, provide stdin, verify exit 0, output, history and task association, deduplicate an active job, and cancel another process. Synthetic output contained no credentials.
- [ ] Add native model-wrapper receipt reattachment, durable jobs to admin/terminal dashboard snapshots, and transparent native Git pull/clone integration using the credential-isolated fetch path. The MCP connection and host-side runtime remain different failure domains.
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
