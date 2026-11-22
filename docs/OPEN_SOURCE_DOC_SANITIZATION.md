# Open-source documentation sanitization — evidence summary

**Date:** 2026-11-22
**Branch:** `agent/oss-doc-sanitize-20261122`
**Scope:** Documentation hygiene for open-source release safety. Only the
files below were edited; no source, `.env`, state, live services, or paths
outside this worktree were touched.

## What was sanitized

Real operator usernames, home-directory paths, tenant/vendor identifiers and
machine-specific deployment topologies were replaced with portable placeholders
or explicit `…<redacted>…` markers. Truthful technical instructions were
preserved.

### `docs/OPERATIONS.md`

| Before | After |
|---|---|
| real home-path `/Users/<op>/repos/local-chatgpt-plus` (two `cd` examples) | `/Users/you/repos/local-chatgpt-plus` (portable example) |
| real home-path `/Users/<op>/lcp-disposable` (Workspace access mode) | `/Users/you/lcp-disposable` |

### `docs/CHATGPT_MCP_DEPLOYMENT_REPORT.md`

| Before | After |
|---|---|
| Repository `you/local-chatgpt-plus` (real username masked) | `you/local-chatgpt-plus` |
| `/Users/<op>/…` (workspace, repo, notes, mode roots) | `/Users/you/…` |
| real `tunnel_…` value (3×) | `tunnel_<redacted>` |
| real `org-…` / `workspace-…` values | `org-<redacted>…` / `workspace-<redacted>…` |
| Auth0 tenant/issuer `…<tenant>.eu.auth0.com/` (2×) | `https://<sanitized-idp-tenant>.eu.auth0.com/` |
| Tenant cell (real tenant slug) | marked `[example tenant — name sanitized]` |
| real `con_…` value | `con_<redacted>` |
| real `tpc_…` value (2×) | `tpc_<redacted>` |
| real `cgr_…` value | `cgr_<redacted>` |

The subject `auth0\|REDACTED_SUBJECT` and `REDACTED_EMAIL` were already
redacted in the source and left as-is.

### `docs/INBOUND_OAUTH_GUIDE.md`

No operator-specific content found. It is already fully portable (generic
`<tenant>` placeholders and public vendor references only). No edits required.

## Verification

- Targeted `grep` scans for `/Users/<op>`, usernames, email addresses,
  real repo owner, and long opaque IDs now match only portable placeholders, the
  project/product name (`Local ChatGPT Plus`), or public vendor endpoints
  (`api.openai.com`, `platform.openai.com`, `a.pinggy.io`, `*.argotunnel.com`,
  `manage.auth0.com`, `chatgpt.com`).
- No secrets, real tunnel/tenant/workspace IDs, or personal data remain in the
  published files listed above.

## Out of scope / not modified

- `AGENTS.md`, `README.md`, `MAINTENANCE_BACKLOG.md`, `SECURITY.md`, and other
  security/review docs were **not** edited (per scope).
- `.env`, `.mcp-state`, source code, running services, and any path outside this
  worktree were **not** touched.
- Opaque IDs already redacted in the source text (`REDACTED_SUBJECT`,
  `REDACTED_EMAIL`) were preserved.
