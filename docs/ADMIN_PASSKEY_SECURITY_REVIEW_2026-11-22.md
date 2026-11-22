# Local Admin WebAuthn security review and remediation — 2026-11-22

**Scope:** isolated feature branch, no live service restart or Apple Passwords credential enrollment. This is a source/fixture security review, not a penetration test or proof of complete security.

## Independent review

A read-only OMP `openai-codex/gpt-5.6-sol` high-reasoning review of the initial passkey branch completed successfully. It examined the token/session bridge, new WebAuthn endpoints, public-key registry and browser integration. The review corroborated registration origin/RP/user verification, CSRF, challenge-replay and private-key storage controls, and found three actionable issues:

| Initial finding | Code-level remediation | Regression evidence |
|---|---|---|
| P1 — localhost cookies are hostname-wide, not port-scoped; another localhost service could receive an authenticated Admin cookie and query its session | Added independent random `X-LCP-Admin-Proof` required on **every cookie-authenticated request, including `/api/auth/session`**. Admin scripts store it in origin-scoped `sessionStorage`; the cookie alone or a cookie plus CSRF token is insufficient. Token Bearer automation remains separately authorized | Cookie-alone 401, cookie+CSRF without origin proof 401, valid proof+CSRF session and writes pass |
| P1 — two Admin instances sharing one registry could restore stale/revoked public-key records or roll back signature counters | Added exclusive 0600 per-registry lock for the Admin server lifetime, fail-closed on a second live PID; safe shutdown releases it, a confirmed-dead PID's stale lock can be recovered | Concurrent start rejected, lock removed on close, synthetic dead PID recovered, invalid store fails before startup |
| P2 — anonymous passkey challenge issuance could evict other users' pending challenges in the 64-entry FIFO | Replaced anonymous issued-challenge FIFO with **stateless HMAC-signed HttpOnly short-lived challenge cookies**. The verifier uses a bounded consumed-nonce replay cache, rejects malformed/expired/forged cookies and consumes a valid challenge before signature verification | Original challenge survives 80 later options requests; signed-cookie tampering rejected; replay rejected; real P-256 login succeeds |

## Other controls

- **Bootstrap/recovery:** Passkey enrollment and revocation require an existing **token-authenticated** cookie session and its CSRF header. A passkey-authenticated session cannot enroll another passkey. Revocation immediately invalidates all sessions established via passkey authentication.
- **WebAuthn:** Uses a vetted WebAuthn library and verifies exact origin `http://localhost:<Admin port>`, RP ID `localhost`, user verification, challenge freshness and digital signatures. A wrong origin, RP hash, or missing verification flag is rejected by synthetic FIDO2 tests.
- **Registry:** Only credential IDs, public keys, nonnegative counters, transport hints and timestamps are persisted outside Git under a private path. World-readable files and symlinks fail closed. Atomic writes preserve file mode 0600. The Mac/browser credential provider holds the private key, not this app.
- **Browser:** The version-locked SimpleWebAuthn bundle is served locally, not from a third-party CDN; the Admin CSP allows only same-origin scripts. A WebAuthn credential can be created only through a human-approved browser authenticator prompt. The Admin token remains available for local authorized automation and recovery.
- **Scope:** These controls do **not** sandbox commands running in Full Machine mode, protect against a malicious process with the same user's OS privileges, or replace the separate remote MCP OAuth boundary.

## Acceptance status

- [x] Build, UI JavaScript syntax and targeted cryptographic WebAuthn test.
- [x] Existing Admin authentication/token rotation/CSRF/redaction tests.
- [x] Synthetic bad-origin, wrong-RP-ID, missing-UV, replay, signature validation and registry locking tests.
- [x] Fresh dependency vulnerability audit: zero currently reported advisories.
- [x] Local source/branch secret-content and Gitleaks scans report zero high-confidence findings.
- [ ] Latest full macOS unit, integration and GitHub PR workflow checks must be green.
- [ ] Physical Safari/Apple Passwords or Touch ID enrollment and sign-in must be manually approved **after** a reviewed merge and controlled deployment. There is no way to create a real user's passkey automatically through CLI scripts.

## Remaining caveats

A new Admin tab does not inherit the existing tab's origin-scoped session proof and therefore may ask for a token or passkey again; this is a security tradeoff rather than an auth failure. Cookies can still be seen by a malicious local web service on a different port but are useless without the independent origin proof. The signing key and replay cache are process-local, so pending passkey login challenges fail after a server restart, as intended. A confirmed-dead-PID lock is recovered; a lock owned by a currently live or ambiguously identified process blocks startup until investigated.

See [Admin passkeys setup](ADMIN_PASSKEYS.md), [security policy](../SECURITY.md) and the public PR for the exact reviewed code.
