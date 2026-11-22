# Inbound OAuth 2.1 for Local ChatGPT Plus — agent implementation specification

**Status:** Planned, not yet implemented. **Repository:** `darizae/local-chatgpt-plus`. **Platform:** macOS / OpenAI Secure MCP Tunnel. **Goal:** authenticate the ChatGPT end user, authorize individual MCP tools, and preserve every existing local coding capability.

## Context and decision

The current deployment uses (1) ChatGPT account/workspace access, (2) the authenticated, outbound-only OpenAI Secure MCP Tunnel, (3) a local secret-bearing `/mcp/<MCP_TOKEN>` path, and (4) Local ChatGPT Plus's application-level permission profile. ChatGPT currently selects **No authentication**; the application is **not** an inbound OAuth resource server. The project's outgoing upstream OAuth-client module is unrelated. Do not claim that OAuth exists until verified.

**Important:** The previously disabled “Create as a plugin” button was traced to an unchecked security acknowledgment by the user; do not treat that UI issue as evidence that OAuth was required. Implement inbound OAuth as a security enhancement, not as a speculative fix for plugin creation.

The target is **Secure MCP Tunnel + OAuth user authentication + MCP resource-server authorization + existing local permissions + optional OS-level isolation**. Keep the existing tunnel private. OAuth protects against unauthorized users, but neither OAuth nor workspace path checks alone sandbox shell commands.

**Primary official references (verify revisions before implementation):**
- [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth) — user sign-in, discovery, ChatGPT client metadata/DCR, PKCE.
- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) — private transport and OAuth discovery.
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) — resource server, `WWW-Authenticate`, resource indicators, scopes and token handling.
- [OAuth Protected Resource Metadata, RFC 9728](https://www.rfc-editor.org/rfc/rfc9728).
- [OAuth authorization server metadata, RFC 8414](https://www.rfc-editor.org/rfc/rfc8414).
- [OAuth resource indicators, RFC 8707](https://www.rfc-editor.org/rfc/rfc8707).
- [OAuth security best practice, RFC 9700](https://www.rfc-editor.org/rfc/rfc9700).

## Ownership and user actions

The coding agent owns the design, implementation, tests, security review and documentation. The user must approve the **identity provider choice** and any cost before a managed provider is provisioned; sign in or create the provider tenant when necessary; authorize a private application / register ChatGPT client metadata or callback URIs when required; configure allowed personal identity/MFA, and complete the **first interactive login and consent** in ChatGPT. The agent must present exact provider-specific actions and redirect URIs discovered from the real ChatGPT UI. Do not invent redirect URIs or demand that credentials be pasted into chat. Store client secrets, issuer URLs, signing keys and provider credentials securely, never in Git.

An existing supported identity provider may avoid manual tenant setup. If none exists, provide a short, evidence-based comparison of vetted hosted identity providers versus operating a dedicated authorization server; recommend the lowest-maintenance option compatible with **CIMD (preferred), DCR (fallback), or explicit pre-registration** and the MCP `resource` parameter. Do not assume generic OIDC/PKCE support automatically satisfies the complete MCP/ChatGPT integration.

## Work plan

### 0. Baseline and architecture decision

1. Read `AGENTS.md`, `README.md`, `docs/OPERATIONS.md`, `docs/CHATGPT_MCP_DEPLOYMENT_REPORT.md`, `src/index.ts`, `src/lib/mcp-session-manager.ts`, `src/lib/permissions.ts` and existing upstream OAuth modules.
2. Record local current Git commit and existing behavior; run the baseline build, tests, MCP Inspector, and tunnel doctor on disposable state only.
3. Inspect the installed `@modelcontextprotocol/sdk` for maintained resource-server/auth middleware, official examples, and supported transport/auth interfaces. Prefer established, audited libraries and an established authorization server over a custom login/token issuer.
4. Specify OAuth issuer, authorization/token/JWKS endpoints, external canonical MCP resource URI, ChatGPT client identity mechanism, TLS, token format/validation, deployment topology and consent UX.
5. **Validate the tunnel routing for discovery** before committing to an architecture. The current tunnel targets a token-bearing local path. Prove that MCP protected-resource metadata and any required `/.well-known/` endpoints can actually be reached through the tunnel under the *external* canonical resource URI. Verify that the provider's browser-facing authorization endpoint is reachable independently; Secure MCP Tunnel does **not** automatically publish the authorization server.
6. Present design, provider fees, user setup steps, rollback plan and security tradeoffs for user approval before provisioning provider accounts or making production auth cutovers.

### 1. Authorization server and identity provider

1. Integrate a vetted authorization server/identity provider supporting authorization-code grant and **PKCE S256**, interactive user sign-in, explicit consent, issuer metadata, secure refresh/revocation or equivalent short-lived-session design, and a published JWKS or introspection endpoint.
2. Prefer **ChatGPT Client ID Metadata Documents (CIMD)** where supported; otherwise configure compatible DCR or a user-approved pre-registered client using actual ChatGPT client ID and redirect URIs. Verify redirect URIs exactly and forbid wildcard/open redirects. Follow official ChatGPT documentation for issuer identification, metadata and client authentication methods.
3. Restrict access to the intended human account/tenant. Require suitable MFA at the provider when available. Do not assume possession of a ChatGPT account alone authorizes the local machine.
4. Preserve scopes and resource indicators in authorization requests and token exchanges; issuer must place the correct canonical resource in token audience (`aud` or validated equivalent). Forbid token reuse against other MCP resources.

### 2. MCP protected-resource discovery and authorization

1. Implement appropriate **RFC 9728 protected resource metadata** for the externally visible MCP resource; advertise actual authorization-server issuer and supported scopes.
2. Ensure the authorization server publishes valid **RFC 8414** metadata, `authorization_endpoint`, `token_endpoint`, `code_challenge_methods_supported` containing `S256`, registration/client metadata support as applicable, and issuer/JWKS/introspection/refresh/revocation metadata as supported.
3. On the intended protected MCP endpoint, unauthenticated calls must receive **HTTP 401** with a valid `WWW-Authenticate: Bearer resource_metadata="..."` challenge and appropriate scope hints; avoid OAuth challenges on unrelated paths and do not expose tools without verified credentials.
4. Verify an `Authorization: Bearer <access_token>` header for **every relevant HTTP MCP operation** — initial handshake, tools/list, tools/call and GET/DELETE/streaming/session recovery as applicable — before any session or tool-side effect. Avoid relying on tool annotations, front-end consent or a cached MCP session ID as proof of authorization.
5. Validate token signature/issuer/audience/`exp`/`nbf`/`iat` as applicable, permitted algorithms, key rotation/JWKS cache, expiry, revocation or active-token checks, subject/account allowlist, client/resource binding and requested scopes. Reject bad issuer/audience, expired, invalid, wrong-account and insufficient-scope tokens with spec-correct errors. Never accept ID tokens or upstream-provider access tokens as MCP resource tokens.
6. Scope taxonomy should be designed before implementation: e.g. `files:read`, `files:write`, `commands:execute`, `computer:use`, potentially narrower repository scopes. Enforce scopes **per tool** including alias/fallback/upstream routes, not just on `tools/list`. Keep Admin UI on its own loopback/auth boundary, never exposed by the tunnel.
7. Bind the authenticated subject and effective scopes to request/session context without allowing cross-user session reuse or privileges to survive token expiry or role changes. Check prompt-injection and deputy risks for Git/shell/upstream tools.

### 3. Compatibility and migration

1. Implement a deliberate, fail-closed inbound auth mode switch. Retain current token-path-only behavior for rollback/testing; **never leave a simultaneously callable token-only route that bypasses OAuth in OAuth-required mode**.
2. Preserve the existing Secure MCP Tunnel, `MCP_TOKEN` secrecy where retained, native tool names and schemas, 71 full/42 slim catalog, Admin UI, PTY, LSP, durable tasks, computer-use protections and recovery state.
3. The OAuth mode must have an explicit policy for tokenized-path compatibility and tunnel profile migration; do not hardcode secret values in metadata, redirect URIs or public OAuth resource identifiers.
4. Do not break local non-ChatGPT MCP clients without a tested documented transition. Do not expose port 3000 or Admin port 3001 publicly or disable permission policies for convenience.
5. Investigate the existing `MCP_SESSION_RECOVERY=true` tunnel double-initialize incompatibility separately. Add a regression test and preserve the known working `false` setting until a verified fix is available.

### 4. Verification and threat testing

Use isolated fixtures, disposable workspaces and test credentials. Add automated tests for:
- Correct PRM and AS discovery under **tunneled** external resource URI, plus inaccessible and malformed discovery.
- Full authorization-code + PKCE S256 state/nonce/code-verifier/redirect validation and consent allow/deny flows.
- Accepted, missing, forged, wrong issuer/audience/resource, expired, revoked, replayed when applicable, insufficient-scope, wrong-account and malformed tokens.
- `401 WWW-Authenticate` challenge, step-up scope behavior, client-registration compatibility, invalid_client, refresh and revocation.
- Token checks on initialize/list/call/GET/DELETE, SSE/reconnect/session reuse and cross-project scope.
- Per-tool permissions for read, write, execution, computer use and upstream-MCP calls; confirmation/approval gates remain in force.
- Key rotation, provider outage, clock skew, network disconnects, replay/idempotency, log and URL secret redaction, and startup failure closed.
- Correct denial of unsafe operations in disposable fixtures, including shell subprocesses; document lack of true OS sandboxing.

Run the relevant focused suites followed by `npm run build`, `npm test`, `npm run test:integration`, `npm run test:all` and full/production dependency audits. GitHub Actions remain disabled until explicitly reauthorized on or after 2026-12-01; use local CI only.

### 5. Real ChatGPT Plus integration acceptance

1. Keep existing OAuth-free plugin connection and working tunnel usable until the new route passes local tests; schedule an explicit user-approved cutover, rather than silently changing a live connector.
2. Have user choose **Authentication: OAuth** only *after* discovery/token exchange is implemented and verified; in ChatGPT's Add Custom MCP Server form choose **Connection: Tunnel** and the existing Local ChatGPT Plus tunnel.
3. User performs browser login, identity verification/MFA and consent, then a real ChatGPT chat exercises read, write, run-test, Git diff, denied out-of-scope operation, expired-token refresh, restart and reconnect.
4. Validate tokens and subject/scopes in the Mac's *redacted* server logs. Verify that the Admin port is never tunneled and a user without consent cannot use the MCP tools.
5. If the tunnel cannot support a required OAuth discovery/callback flow, record the exact blocker, consult current official docs and propose an alternative architecture **without** disabling security.

**Done when:** A real ChatGPT Plus user signs in via OAuth 2.1 through Secure MCP Tunnel; all relevant MCP operations require valid, audience-bound, appropriately scoped access tokens; consent/expiry/refresh/revocation and negative tests pass; current capabilities remain intact; local CI passes; and the deployment report records the outcome and rollback steps.

## Deliverables

- Reviewed architecture decision and chosen identity-provider integration, with user-specific manual setup instructions.
- Implementation on a reviewable local branch, tests, documented security boundaries and migration/rollback.
- Updated `README.md` security-model status diagram and `docs/OPERATIONS.md` configuration, with secrets excluded.
- Updated `MAINTENANCE_BACKLOG.md` status and `docs/CHATGPT_MCP_DEPLOYMENT_REPORT.md` after actual end-to-end tests; no fabricated success.
- Clear **READY / READY WITH LIMITATIONS / BLOCKED** OAuth readiness verdict and a copyable ChatGPT registration checklist.

**Stop-and-ask boundaries:** provider selection/payment, actual account creation/login, MFA/consent, entering real secrets, public DNS/hostname additions, live auth cutover, and any security relaxation. Ordinary coding/test/commit work should proceed autonomously.
