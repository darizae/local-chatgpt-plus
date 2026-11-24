# Administrator handoff: Aruba VPS

This is the one-time installation checklist for the next authorized administrator SSH session (Mac or Aruba console). Do not run these administrator commands through the restricted MCP runtime. The ordinary agent build and commits already reside in the VPS checkout; no remote push is required.

## 1. Stage, review, preflight

Keep the independent administrator session open throughout. Confirm the expected final commit with the ChatGPT development session; check that no unrelated repository changes or model jobs are outstanding. In the administrator terminal, using Bash:

```bash
set -euo pipefail
repo=/home/agent/workspaces/projects/local-chatgpt-plus
commit=$(sudo -u agent /usr/bin/git -C "$repo" rev-parse --short=12 HEAD)
echo "Staging commit $commit"
sudo test ! -e /root/lcp-reviewed
sudo install -d -o root -g root -m 0700 /root/lcp-reviewed
sudo -u agent /usr/bin/git -C "$repo" archive "$commit" \
  scripts/lcp-vps-install.sh scripts/lcp-vpsctl scripts/lcp-vps-health.py \
  scripts/lcp-vps-backend-reliability.conf scripts/lcp-vps-tunnel-reliability.conf scripts/vps | \
  sudo tar --extract --no-same-owner --no-same-permissions -C /root/lcp-reviewed
sudo bash /root/lcp-reviewed/scripts/vps/lcp-admin-preflight.sh "$commit"
```

If the staging path already exists, archive the old reviewed snapshot separately before continuing. Review the new staged scripts and unit files before execution as root. The preflight is read-only and validates the build stamp and queue idleness; the installer also checks these conditions at cutover. Keep the reported backup directories until acceptance is complete. The exact installation code and rollback behavior are documented in [Linux VPS operations](LINUX_VPS_OPERATIONS.md).

## 2. Production migration

```bash
sudo bash /root/lcp-reviewed/scripts/vps/lcp-admin-install.sh
sudo systemctl is-active lcp-vps.service lcp-vps-tunnel.service lcp-durable-jobs.service
sudo -u agent /usr/local/bin/lcp-agent-queue-client capacity
sudo -u agent /usr/local/bin/lcp-maintenance-client status
sudo -u agent /usr/local/bin/lcp-git-sync status
sudo systemctl show lcp-vps.service lcp-agent-queue.service -p MemoryMax -p CPUQuotaPerSecUSec -p TasksMax
```

The installed backend must report the reviewed compiled commit. Both rolling SAIA quota fields must be null. Verify a fresh Aruba MCP tool call, then start a harmless model job within the new default budget. Validate developer environment, PTY, subprocess REPL, and Git dry-run; don't publish or modify remotes merely to test.

## 3. Rootless Docker

```bash
sudo bash /root/lcp-reviewed/scripts/vps/lcp-install-rootless-docker.sh
sudo -u agent /usr/bin/bash /home/agent/workspaces/projects/local-chatgpt-plus/scripts/vps/lcp-docker-smoke.sh
```

The second script pulls a public Alpine test image, runs it through Compose on the dedicated rootless socket, and removes its temporary Compose resources. It does not touch existing production containers. The existing rootful socket remains inaccessible. Explicit per-repo bind-mount ACLs are available if needed. Docker image download, kernel user namespaces, and daemon startup are live acceptance conditions.

## 4. GitHub account credential

After the Git broker migration, generate a dedicated VPS key from the independent administrator session:

```bash
sudo bash /root/lcp-reviewed/scripts/vps/lcp-github-account-key.sh create
```

Copy **only the printed public key** into GitHub Settings → SSH and GPG keys → New SSH key (authentication key). Use the intended GitHub account. This credential will be able to access the account's authorized repositories; the broker additionally restricts origin ownership, normal push behavior and credential scans. Existing repo-specific keys retain precedence. GitHub rules still apply. No account key or secret is needed in ChatGPT.

After the public key is registered, activate using an existing repository under that owner which the account can read (use the actual repository name):

```bash
sudo bash /root/lcp-reviewed/scripts/vps/lcp-github-account-key.sh activate REPOSITORY_NAME
```

Activation performs a remote authentication probe before atomically updating the root-owned policy and verifies broker status. Use an authorized *new* private checkout to validate account-key fallback via `lcp-git-sync fetch` and `lcp-git-sync push --dry-run`. Do not change GitHub branch rules or actually push simply for this test. The account-level key is broader than a per-repo deploy key; an installation-scoped GitHub App is a possible later alternative.

## 5. Durable job acceptance

The supervisor runs independently of the MCP/tunnel units, under the same ordinary development UID and a separate systemd cgroup. Once installed, use existing MCP process tools:

1. `start_process` in the local-chatgpt-plus checkout with command `printf 'BEFORE_RESTART\\n'; read -r value; printf 'AFTER_RESTART:%s\\n' "$value"`. Record the returned `dur-...` ID and PID. Do not use a command containing credentials.
2. Read `process_output` and confirm BEFORE_RESTART and running=true. From the independent administrator session or existing maintenance client, restart the MCP at the reviewed build commit. Do not restart the durable supervisor itself.
3. After a fresh connector call, query `process_status` with the same ID and workspace. Verify the same PID and running=true. Send `process_input` with the test value, then `process_output` with wait_for=exit. Confirm AFTER_RESTART and exit_code=0. Check `process_history` reports completed.
4. Verify task association, duplicate running-job reuse, wrong-workspace rejection, and stop a separate harmless long-running test with `stop_process`. Record supervisor PID before and after MCP restart: it must be unchanged.

The automated non-root integration test launches separate MCP server processes and already exercises reattachment, stdin, output, history, deduplication, cross-project denial, stop and supervisor-crash receipt handling. The live systemd/tunnel restart remains necessary for acceptance.

## 6. Boundaries and rollback

Persistent jobs preserve stdout/stderr tails privately (512,000 bytes per stream, latest 250 finished jobs; running jobs not evicted); commands are not stored verbatim. Treat output as potentially sensitive and do not print credentials. The spool is a deliberate, opt-in local change from metadata-only operation history; no output is published to admin history. Jobs do not automatically rerun on supervisor/host restart; unfinished receipts are marked interrupted. Use foreground commands for long-lived servers. Legacy synchronous commands and PTY sessions are not migrated, and native `subagent` receipts need separate reattachment work. The underlying SAIA queue already runs independently; its direct receipt client is available.

If a core installer phase fails, inspect the reported backups and keep administrator access. Rootless Docker and account-key setup are separate phases, so they do not block core MCP installation. Do not rerun the installer while the independent job supervisor is active; first review active jobs and plan an explicit supervisor upgrade. See the operations guide for configuration rollback and restoring a known-good compiled application.
