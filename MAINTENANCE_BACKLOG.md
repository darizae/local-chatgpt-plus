# Local ChatGPT Plus — public release backlog

**Last reviewed:** 2026-11-22. The original maintainer's private deployment logs and historical identifiers are intentionally not part of the public source history. This is the release-facing backlog; all checkboxes indicate evidence-based work remaining.

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

## Follow-up engineering work

- [ ] Improve safe retry/cancellation and crash/reconnect coverage.
- [ ] Browser/Desktop provider permission review and approval parity.
- [ ] macOS login/logout, `launchd` and offline availability matrix.
- [ ] More extensive Admin XSS/status/diagnostic canary coverage.
- [ ] Automated dependency and vulnerability review cadence.
- [ ] Manual/agent-assisted setup verification for tunnel providers.
- [ ] Optional billing/analytics integration only after an independent review of credential isolation.

See [security release gates](docs/OPEN_SOURCE_RELEASE_SECURITY.md), [Sol review](docs/OPEN_SOURCE_SOL_REVIEW_2026-11-22.md), [Security policy](SECURITY.md) and [install guide](docs/OPEN_SOURCE_SETUP.md).
