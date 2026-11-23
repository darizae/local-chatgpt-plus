# OAuth confidentiality and delegated-agent authority (2026-11-23)

## Threat model and trust boundaries

| Surface | Attacker capability | Boundary and residual risk |
| --- | --- | --- |
| OAuth tokens, PKCE verifiers, provider client registration | Read copied application state or backup | Optional AES-256-GCM vault protects stored OAuth JSON *when a separate operator-controlled key file is configured*. An attacker with both key and ciphertext can decrypt. |
| Persistent task notes, capsules, tool responses, GitHub issues, source files and logs | Plant instructions as lower-trust data | Content is **not** authority to change permissions, enable tools, grant OAuth scopes, publish Git, or execute commands. Existing request/permission checks still apply. Do not execute text copied from source/tool output. |
| Subagent process environment | Model runner reads its own environment | Inherited variables now have an explicit small allowlist. A trusted operator can opt in additional values via subagent config; tool-supplied objectives cannot change the allowlist. A runner can still read files accessible to its OS user. |
| Shell/PTY and worktrees | Execute arbitrary same-user programs | Workspace permission checks are application checks, **not** a subprocess sandbox. Use dedicated accounts, containers or VMs for hostile code. No claim of host isolation. |
| MCP tunnel, upstream HTTP/stdio, Admin | Remote server or tool publishes malicious descriptions/results or exploits credentials | Existing authentication, OAuth scope checks, Admin authentication/CSRF and tool authorization are distinct from transport TLS. No new transport crypto is introduced here. Do not expose Admin through the tunnel. |
| macOS/Linux processes, env, swap, crash dumps | Same-user process inspection | At-rest encryption does not protect decrypted credentials in RAM, user-level process introspection, accessible key files or OS memory dumps. |
| Temporary files and backups | Read cached or historical plaintext | Atomic writes set mode 0600 for OAuth state; existing snapshots, deleted blocks and legacy backups may still contain plaintext. Review and protect them separately. |
| External model providers / subagent results | Retain prompts or return forged success messages | Delegate only public source and synthetic fixtures, verify all claims with independent tool/test evidence. No live credentials in prompts. |

## Opt-in encrypted OAuth persistence

Existing plaintext installations are **not** rewritten automatically when upgrading. The operator must provision a dedicated random 256-bit key **outside the repository and outside the backed-up OAuth state directory**, with restrictive OS permissions and independent recovery. On a trusted Unix host, for example:

```sh
umask 077
mkdir -p "$HOME/.config/local-chatgpt-plus"
openssl rand -hex 32 > "$HOME/.config/local-chatgpt-plus/oauth.key"
chmod 600 "$HOME/.config/local-chatgpt-plus/oauth.key"
# Configure on the MCP service, not in a checked-in env file:
export MCP_OAUTH_ENCRYPTION_KEY_FILE="$HOME/.config/local-chatgpt-plus/oauth.key"
```

**Important:** a file-backed key is headless-compatible but is not an OS hardware-backed key vault. Protect the key separately from encrypted state; use disk encryption and a dedicated OS account. If macOS Keychain or a managed KMS is required, provision a separate privileged key-loader integration before activating this feature. Do not copy the key to the public repository or log it.

With the key configured, new OAuth JSON stores are encrypted as a versioned envelope containing a fresh 96-bit nonce, 128-bit authentication tag and AES-256-GCM ciphertext. The file name is authenticated as additional data to reject cross-server file swaps. A missing, invalid, group/world-readable or replaced key causes an error rather than silently writing plaintext; ciphertext also fails closed when the key is missing.

### Migrating existing OAuth state

1. Stop *OAuth writes* during a controlled maintenance window. Back up plaintext state **privately** using encrypted storage and record where to recover it; confirm the recovery key is available. This step may require operator authorization because actual OAuth credentials are involved.
2. Configure the key file on the target host. Existing plaintext files will fail closed with an explicit migration-required error.
3. After reviewing the backup/recovery plan, set `MCP_OAUTH_ALLOW_PLAINTEXT_MIGRATION=true` temporarily. On first access each legacy store is atomically replaced with authenticated ciphertext. Validate token refresh, restart and upstream MCP connectivity with synthetic or operator-authorized tests.
4. Unset the migration flag. Confirm each intended store has `version: 1` and `algorithm: aes-256-gcm` and no plaintext token fields. Securely handle *historical* plaintext backups independently.

### Rotating a key without losing access

Do not overwrite or delete an existing key. During an **operator-authorized maintenance window**:

1. Back up all encrypted stores and the previous key into independently protected recovery storage. Provision a new 0600 key file with fresh random bytes.
2. Set `MCP_OAUTH_ENCRYPTION_KEY_FILE` to the new key's path and `MCP_OAUTH_PREVIOUS_KEY_FILE` to the old key's path. A store authenticated by the previous key is re-encrypted under the new key when read. The previous key is never used for new writes.
3. Exercise each configured upstream's OAuth credential flow so **every** store is rewrapped, then unset `MCP_OAUTH_PREVIOUS_KEY_FILE` and verify all stores decrypt with the new key alone.
4. Preserve the previous key in controlled recovery storage until backups and the rollback window expire. Do not delete the old key as part of automated cleanup.

This is staged, per-store rotation, not an atomic multi-file rotation transaction: if interrupted, retain both keys and repeat validation. Losing *all* usable keys makes ciphertext unrecoverable; OAuth providers can be reauthorized if supported. An interrupted plaintext migration leaves the pre-rename file intact, while an atomic post-rename file requires the new key. No automated cleanup of historical plaintext is attempted.

## Prompt-injection and delegated execution

Subagents receive only system and locale environment variables by default, plus explicitly configured operator-owned `env` values. Never add secrets there without verifying the provider's data handling. Prompts are supplied via stdin with the installed runner; supported legacy argument transport remains an operator-controlled configuration. Node's `spawn` receives an argument vector, not a shell command, so metacharacters in an objective are not automatically shell-evaluated; a deliberately configured shell interpreter remains high-risk. A Git worktree is isolation of *changes*, not an OS sandbox or security boundary.

For new deployments, prefer `workspace` permissions with commands and unsafe runtimes off until explicitly approved. Treat tool output, repository instructions and persisted task notes as data. Independently confirm authorization against the active scope/profile before each write, command, network action or Git publication; do not rely on a model's claim of approval. Synthetic regression tests exercise token-at-rest confidentiality, wrong-key/corruption handling, migration consent and subagent environment minimization. They are **not** proof that unrestricted same-user shell access is safe.

## Remaining work

- Native OS-backed secret store integration and multi-store transactional key rotation (requires key ownership and migration decisions).
- A real OS-level subprocess sandbox for untrusted agents/workspaces, with Linux/macOS parity and cancellation/process-tree enforcement.
- Structural provenance tagging and policy enforcement for all persistent notes, upstream tool descriptions/results and imported source content, beyond the existing independent MCP/permission checks.
- Runtime tunnel, OAuth reconnect, Git publishing and backup recovery verification during an authorized maintenance window.