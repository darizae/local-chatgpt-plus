# Agent-assisted installation and manual setup

This guide is for a **new machine**, not for migrating an existing live installation. No remote account, private domain, or existing machine-specific path is required.

## Give this to your coding agent

> Clone `https://github.com/darizae/local-chatgpt-plus` into a new directory on my Mac. Read `AGENTS.md`, `README.md`, `docs/OPEN_SOURCE_SETUP.md`, and `docs/INBOUND_OAUTH_GUIDE.md` before making changes. Verify macOS, Node.js >=22.22.2, pnpm 11.1.3, and Git. In an isolated checkout run `pnpm install --frozen-lockfile --ignore-scripts`, verify signatures and advisories with `pnpm audit signatures`, `pnpm audit --prod`, `pnpm audit`, and `node scripts/check-osv-dependencies.mjs`, then run approved builds with `pnpm rebuild`, followed by `pnpm run build`, `pnpm run test:smoke`, and `pnpm test`. Do **not** start the daemon, install launchd jobs, alter login items/macOS security settings, expose a public port, import credentials, configure external providers, or change any running service without asking me. Make a fresh disposable `WORKSPACE_PATH` and a private `PERMISSIONS_CONFIG` (workspace profile). Keep `.env` private (mode 600) and disable Admin by default. Report manual OAuth/tunnel/ChatGPT steps, missing prerequisites, and test results. Never print secrets or paste sensitive file contents into the chat.

## Local bootstrap

1. Install a supported Node.js and Git. Download/clone the repository into a new empty directory.
2. Run:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm audit signatures
pnpm audit --prod
pnpm audit
node scripts/check-osv-dependencies.mjs
pnpm rebuild
pnpm run build
pnpm run test:smoke
pnpm test
mkdir -p "$HOME/lcp-workspace"
cp .env.example .env
chmod 600 .env
cp profiles/permissions.example.json profiles/permissions.json
chmod 600 profiles/permissions.json
```

3. Review the ignored `profiles/permissions.json`: the checked-in example already sets `"profile": "workspace"`, `"allow_unsafe_runtimes": false`, and `"path_roots": []` so the runtime uses `WORKSPACE_PATH`. **This restricts declared file paths/cwds, not what a shell subprocess can do**. For stronger isolation use a dedicated OS user, VM or container with constrained mounts/network.
4. Edit `.env` (do not paste secret values into chat):

```dotenv
HOST=127.0.0.1
WORKSPACE_PATH=/absolute/path/to/your/disposable/workspace
PERMISSIONS_CONFIG=profiles/permissions.json
LOCAL_CODER_ADMIN_ENABLED=false
CHATGPT_AUTO_APPROVE=false
INBOUND_AUTH_MODE=token
MCP_TOKEN=<GENERATE_LOCALLY_AND_KEEP_PRIVATE>
```

Generate a random token locally using `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Replace the placeholder, never commit `.env`. Do **not** expose `/mcp` with an empty token. Start with `pnpm start` and inspect `http://127.0.0.1:3000/health`. Stop with Ctrl-C before changing configuration.

## Authentication choices

**Token mode (quick local bootstrap).** The default `INBOUND_AUTH_MODE=token` accepts the long random token in the path `/mcp/<MCP_TOKEN>`. The ChatGPT connector may call this “No authentication” because it does not perform OAuth: the URL token is still a credential. Keep the URL private. Use an authenticated HTTPS tunnel; never expose raw HTTP to the internet.

**OAuth mode (stronger identity controls).** Follow [Inbound OAuth guide](INBOUND_OAUTH_GUIDE.md) and [Operations / tunnel setup](OPERATIONS.md#tunnel-options). Set `INBOUND_AUTH_MODE=oauth`, `INBOUND_OAUTH_ISSUER`, `INBOUND_OAUTH_RESOURCE_URI` (the canonical external HTTPS MCP URL), and `INBOUND_OAUTH_ALLOWED_SUBJECTS`. Configure the external provider's JWT audience, Authorization Code + PKCE S256, consent/scopes and MFA. In OAuth mode the token-in-path route is disabled; ChatGPT sends a signed Bearer token and LCP validates issuer, audience, signature, expiry, subject, and per-tool scopes. The identity provider and tunnel are **separate** services.

## Steps a human must perform

- Provision and authorize your own tunnel service in its vendor dashboard. Give the tunnel only the MCP port, **never the Admin UI**; keep tunnel runtime credentials locally and restricted. Exact vendor-specific steps may change.
- If using OAuth, create the IdP application/resource/API, choose redirect/client registration policy, confirm the intended subject and scopes, and complete login/MFA/consent in the browser. Never allow the agent to obtain or publish a credential by copying it into the repository.
- In ChatGPT, create/enable the custom MCP connection, select the intended authentication mode, and review the permission prompts. Refresh/reconnect the connector after changing schemas or credentials.
- Optional: explicitly approve installation of `scripts/lcp-install.sh`, per-user launchd jobs, macOS Accessibility/Automation permissions, and any optional desktop/browser integration. These are **not** prerequisites to the base MCP server.
- Back up and rotate local secrets and review accessible macOS filesystem permissions. Do not share `.env`, tunnel config, `.mcp-state`, activity logs or OAuth token stores.

## Before allowing an agent full access

Run `git status --short` and `pnpm run test:smoke`. Confirm the selected permission profile is **not** `open`; `WORKSPACE_PATH` alone does not restrict shell access. Grant `commands:execute`, computer use, upstream MCP connections and subagent execution only if needed. Do not enable public access until [release security gates](OPEN_SOURCE_RELEASE_SECURITY.md) are satisfied.
