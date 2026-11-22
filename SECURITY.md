# Security policy

Local ChatGPT Plus exposes filesystem, shell, Git, process, and optional computer-use capabilities of the operating-system user. A connected agent can cause real side effects. **Do not assume the local permission profile is an OS sandbox**, especially when command execution is enabled. Treat the MCP endpoint and any tunnel as sensitive administration access.

## Reporting vulnerabilities

Please **do not open a public issue containing exploit steps, active service URLs, tokens, private hostnames or personal information**. Use the repository's GitHub private vulnerability reporting feature if enabled, or contact the maintainer through an agreed private channel. Include affected version/commit, prerequisites, a minimal sanitized reproduction, impact and a proposed fix. Do not probe third-party systems or this project's maintainer's personal deployment.

## Supported versions and scope

Before a tagged public release, this repository is **pre-release software**. Fixes and support commitments are not yet guaranteed. We do not claim formal penetration testing or secure multi-tenant isolation. Current risks and release blockers are documented in [the release-security checklist](docs/OPEN_SOURCE_RELEASE_SECURITY.md).

## Hardening defaults for new operators

Use a dedicated macOS account or OS-isolated environment for untrusted workloads. Configure a private workspace, an explicit non-`open` permission profile, no unnecessary shell/PTY/subagent/upstream tools, and authentication at the MCP boundary. Disable Admin until its authentication is configured and tested, and never expose its port through a tunnel. Keep all credentials out of Git and logs. Review every agent-requested tool capability and promptly update dependencies.

## Disclosure process

The maintainer will evaluate privately submitted reports, reproduce using disposable fixtures, assess impact, coordinate a fix, and publish a non-sensitive advisory when appropriate. No response deadline is promised before release.
