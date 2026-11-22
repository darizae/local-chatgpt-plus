# Deployment verification — public guide

The private maintainer's historical deployment record is intentionally excluded from this public-source export. It contained machine-specific operational history that is irrelevant to safely installing the project and should not be copied into a public repository.

To deploy your own instance, consult [Agent-assisted setup](OPEN_SOURCE_SETUP.md), [Operations and tunnel setup](OPERATIONS.md), [Inbound OAuth guide](INBOUND_OAUTH_GUIDE.md) and [Release security gates](OPEN_SOURCE_RELEASE_SECURITY.md).

The source includes isolated OAuth, session, permission and MCP bridge tests, but **those tests do not validate your IdP, tunnel provider, macOS privacy settings or production machine**. Verify those manually before publishing a reachable service.
