# Security review — 21 November 2026 (P0.5 / P2.7 incremental)

## Scope and results
- Baseline main: 637422b84f5c7dc9cdae5c10ebbbc5158616ad8d.
- Isolated macOS arm64, Node 26.13.0, no live restart, tunnel, browser, or credential changes.
- npm audit --json --audit-level=low: exit 0, 0 reported advisories.
- pnpm audit --json: exit 0, 0 reported advisories.
- npm lock resolves @modelcontextprotocol/sdk 1.32.2, express 5.3.0, zod 4.6.7, jose 6.2.18, node-pty 1.1.0.
- MCP upstream advisories: https://github.com/modelcontextprotocol/typescript-sdk/security/advisories
- Historical GHSA-22jm-h49p-29qw and GHSA-6prh-2h8m-c8cw affect SDK versions below resolved 1.32.2.

## Addressed code-level finding
The existing GET /api/config/env endpoint returned raw .env configuration values including secrets. Isolated patch omits sensitive value keys and returns redacted_keys; blank secret fields on PUT preserve the existing secret; attempts to submit a nonblank secret without ADMIN_TOKEN are denied. Frontend shows a blank password input with preservation hint. Synthetic-secret integration test verifies no GET leakage, preservation on edit, and rejected unprotected secret rotation. npm test and build were run separately.

## Limitations and follow-up
P0.5 and P2.7 remain OPEN. This is not complete Admin authentication, Host/Origin/CSRF/DNS-rebinding protection, or an audit of all config/status/upstream endpoints. A missing ADMIN_TOKEN still permits other local Admin operations. Real OAuth/tunnel, macOS permissions, third-party upstream packages, and deployed code are not validated. No billing integration or production rollout was performed. Both lockfile audits reporting zero findings do not establish absence of vulnerabilities.

Next: review all Admin responses with synthetic secrets, extend auth/CSRF protections, rerun release regressions, validate installed build in an approved maintenance window, and conduct the recurring day-specific advisory review.
