# Linux VPS self-service operations

## Why the subagent was rejected

The original queue had a hardcoded limit of four model submissions in a rolling 24-hour window. Failed jobs counted because they may have consumed provider resources. The broker replaced every queue error with a generic rejection. A healthy broker and an idle worker therefore did not imply capacity to submit.

The versioned queue, broker and native launcher in `scripts/vps/` expose typed, allowlisted failure reasons and a read-only capacity query. The owner subsequently directed that the artificial rolling job-count and aggregate-cost quotas be removed entirely. Both admission checks are deleted, including when an old policy file still contains those fields. Historical job count and reserved cost are telemetry only, not a throttle.

The native launcher now defaults to **$1 per job and 15 minutes**, with configurable launcher arguments up to **$5 and 30 minutes**. The host bootstrap updates the ordinary user's native launcher profile to those defaults and four submission slots, with a three-hour parent timeout. The queue worker still runs one model job at a time, oldest first; the execution timeout starts when a job actually begins. There is a configurable in-flight queue bound (32 by default, up to 128), not a daily quota. There is no automatic aggregate spend cap; actual provider costs and provider-side rate/billing limits are independent. The launcher returns the broker job ID, pinned base commit and worktree. A dirty parent checkout no longer blocks submission: the isolated worktree uses the committed HEAD at submission, not uncommitted edits. Results and prompts have larger bounded payloads (12,000 and 24,000 characters respectively).

No live quota or launcher profile is changed merely by compiling the repository. The one-time bootstrap installs these versions. Legacy error messages remain recognized so old brokers can be diagnosed during migration.

## One-time administrator bootstrap

For the full phased installation, including Docker, GitHub account authentication and live durable-job restart acceptance, use [VPS administrator handoff](VPS_ADMIN_HANDOFF.md). The independent durable job supervisor is installed as part of core bootstrap.

Do not grant arbitrary sudo to the MCP process or let an agent-writable script execute as root. The host account and its systemd restrictions are deliberately independent of OAuth. The following one-time bootstrap is for the host administrator over the already authorized SSH or console channel. It installs a small fixed-operation maintenance interface; future routine application restarts do not need administrator interaction.

1. In the VPS checkout, ensure there are no unrelated changes, run `npm run test:vps`, commit the desired source, and run `npm run build:vps` as the ordinary agent account. The build stamps the exact commit and SHA-256 digest of compiled JS; the server checks the stamp at startup. The previous dist tree is retained in `.mcp-state/vps-dist-previous`.
2. Check that no model jobs are queued or running and that the existing MCP services are healthy. Keep the administrator SSH connection open during bootstrap.
3. From a trusted administrator session, stage **only** the reviewed, committed artifacts under a new root-owned directory. Review the snapshot in that directory before executing anything:

```bash
# Run from the repository checkout as the authorized host administrator.
sudo install -d -o root -g root -m 0700 /root/lcp-reviewed
sudo -u agent git -C /home/agent/workspaces/projects/local-chatgpt-plus archive HEAD \
  scripts/lcp-vps-install.sh scripts/lcp-vpsctl \
  scripts/lcp-vps-health.py scripts/lcp-vps-backend-reliability.conf \
  scripts/lcp-vps-tunnel-reliability.conf scripts/vps | \
  sudo tar --extract --no-same-owner --no-same-permissions -C /root/lcp-reviewed
# Review the staged scripts and units first. No daily quota exists.
# The default in-flight queue bound is 32; the example policy is optional.
sudo bash /root/lcp-reviewed/scripts/vps/lcp-admin-install.sh
```

Use a fresh empty staging directory (if it already exists, inspect and archive it first); do not extract unreviewed code as root. The installer checks ownership/modes, backs up existing host files, stops the broker before checking for outstanding jobs, preserves queue isolation and installs the reliability migration. It starts the maintenance socket independently of the MCP. It preserves an existing operator queue policy, but the old rolling quota fields no longer have any effect. It also places npm, pnpm, pip, uv and browser-download caches in the existing writable workspace rather than the read-only home. If a later step fails, it restores the queue/broker artifacts and their active states; a successfully completed earlier tunnel migration remains in place. Preserve the reported backups and administrator access until live verification passes.

## Development capability migration

The combined installer also replaces the old Git broker with a reviewed credential-policy implementation, applies workspace-local caches and Git identity, removes the MCP/queue cgroup CPU/memory/task caps, enables separately scoped interactive PTY, subprocess REPL and explicitly configured upstream tools, and removes the legacy local Git/recursive-cleanup regex blocks. It does not enable general host administration or disclose provider credentials. It verifies the actual running application's stamped commit before declaring the reliability migration successful.

The account's existing per-repository SSH credentials are migrated automatically. Normal non-force push of the checked-out branch, including main, does not require a clean working tree. The broker checks actual remote refs and scans newly reachable committed objects; GitHub's access and branch rules remain authoritative. For arbitrary new repositories, the authorized administrator must provision a GitHub account credential or repository key and set the corresponding basename in root-owned `/etc/lcp-vps/git-policy.json` (never put a private key in the checkout). The optional account credential removes per-repo mapping requirements for repositories it can access. Use `lcp-git-sync fetch` to fetch private origin branches without exposing keys; use `lcp-git-sync push --dry-run` for a publication preflight. Existing force/delete/tag restrictions and provider policies remain.

For Docker/Compose support, after core bootstrap succeeds, run the independently reviewed rootless installation:

```bash
sudo bash /root/lcp-reviewed/scripts/vps/lcp-install-rootless-docker.sh
```

This installs required user-namespace helpers and starts a dedicated non-root daemon with an agent-only Unix socket. It does not expose the existing rootful Docker socket. Build contexts and named volumes work independently of the agent's private home. To bind mount a particular checkout, run `bash scripts/vps/lcp-dev-docker-bind.sh /absolute/path/to/repo` as its owner, explicitly granting the isolated container identity access to that repository. Compose plugin availability and actual daemon/container startup must be verified after installation.

The workspace-local tools can already be used without restarting MCP:

```bash
source scripts/vps/lcp-dev-env.sh
pnpm --version
playwright --version
```

`bash scripts/vps/lcp-dev-provision.sh` is the pinned reproducible non-root setup and Chromium smoke test. The live VPS has already passed the npm installation and Chromium rendering probe.

## Normal development after bootstrap

From the VPS checkout, using the ordinary agent account:

```bash
npm run test:vps
# Commit the tested change, then:
npm run build:vps
/usr/local/bin/lcp-maintenance-client restart --commit "$(git rev-parse --short=12 HEAD)"
```

The last command returns an accepted receipt before the MCP transport is interrupted. Systemd runs the restart independently of ChatGPT and SSH. After reconnection, run:

```bash
/usr/local/bin/lcp-maintenance-client status
/usr/local/bin/lcp-agent-queue-client capacity
```

The maintenance status must be `completed`, the runtime commit must equal the requested compiled commit, and both service PIDs must differ from their pre-restart values. Verify the connector by executing a fresh actual MCP tool call. The restart worker also invokes the existing tunnel-readiness check, including fresh OpenAI polling. Explicit OFF remains authoritative; the broker will not turn off services back on. If deployment fails, retain the receipt and use the independent authorized administration path; roll back to a known-good committed build and restart. This first bridge does not automatically roll back application source or root components.

## Persistent background jobs

When the VPS service configures `LCP_DURABLE_JOBS_SOCKET`, the existing `start_process` tool automatically launches jobs through a separate non-root systemd supervisor, rather than attaching them to the MCP backend's cgroup. Its existing status, history, output, input and stop tools recognize durable IDs, and task execution status includes those jobs. Repeating an identical still-running start reuses the job. An unavailable configured supervisor returns an explicit error; it never silently starts a second local job. The durable job service has no dependency on the MCP or tunnel service.

The daemon retains private, bounded stdout/stderr tails (512,000 bytes per stream, latest 250 finished jobs) so output is recoverable after reconnect. Raw command text is withheld from durable metadata. This is an explicit opt-in change from metadata-only history on other installations. Do not print credentials. Use foreground commands for long-lived processes. A supervisor restart or host reboot interrupts its jobs; persisted receipts are marked interrupted, never automatically replayed. Legacy local processes, synchronous commands, PTYs and the native subagent wrapper are not covered by this first migration. The separate model queue can be accessed using its direct job receipts.

## Security and remaining acceptance tests

The root worker accepts only `status` and `restart(commit, receipt)`, uses fixed service identities and the installed root-owned controller, and rejects arbitrary arguments, paths and commands. It checks Unix peer credentials, bounds requests and restart frequency, and serializes restarts with the phone controller. The model worker is configured to have the maintenance socket directory hidden. Access is by the local agent UID, not a new assertion of individual OAuth caller identity. The host administrator must still review changes to privileged components; an approved/signed privileged release workflow is separate future work.

After bootstrap, verify the live capacity response has null rolling limits, a paid SAIA job with the new default budget, the actual broker capacity response, refusal of invalid maintenance requests, inability of the isolated model worker to access the socket, a real application restart with a fresh connector call and the stamped commit, and iPhone ON/OFF plus Tailscale disconnection. Hermetic tests and unit syntax checks do not establish these live results.

## Live migration acceptance (2026-11-24)

The reviewed administrator bootstrap was installed on an existing VPS. A startup race in the queue broker readiness check was corrected; the rootless Docker service needed a complete executable PATH, child readiness notification, and a persistent user manager/session bus for delegated cgroups. All fixes are versioned. Rootless image pulls, builds, Compose, named volumes, explicit workspace bind mounts and inter-container HTTP were exercised, including an isolated PostgreSQL schema migration. Existing rootful containers were left running. Docker attached output through the local proxy can be unreliable; use detached jobs and container logs with exit-status verification.

Actual model jobs passed with a clean and a dirty parent. Both rolling quotas were absent. A normal unprivileged maintenance restart changed the backend and tunnel PIDs, verified the new runtime commit, and allowed a fresh connector call. A durable job retained its ID and PID, original output and task association; stdin, completion, duplicate detection and cancellation passed. The maintenance broker refused an arbitrary execution request. The effective queue sandbox hides maintenance and durable-job sockets.

The account-level credential was registered through an existing authorized GitHub session. New private checkouts, normal main/dirty push dry-runs and branch pushes succeeded. For repositories using Git LFS, install git-lfs as administrator, then use `git lfs install --local --skip-smudge`, `lcp-git-sync lfs-fetch`, `git lfs checkout` and `git lfs fsck`. The transfer broker performs authenticated operations in a private temporary bare repository, rejects custom LFS config and verifies object content hashes. `lfs-push --dry-run` is an explicit HEAD-only upload preflight; upload across multiple historical commits has not been accepted. Never copy keys to checkouts.

Workspace cache directories now include XDG_CONFIG_HOME, MPLCONFIGDIR and DOCKER_CONFIG as well as npm, pip, uv, browser and Git configuration. For an already-running independent supervisor, a reviewed supervisor update requires an explicit maintenance window with no running durable jobs; routine MCP deployments never restart it. See the backlog for remaining upstream, phone, adapter and privileged-component release tests.
