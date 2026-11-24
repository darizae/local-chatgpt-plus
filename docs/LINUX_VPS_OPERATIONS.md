# Linux VPS self-service operations

## Why the subagent was rejected

The original queue had a hardcoded limit of four model submissions in a rolling 24-hour window. Failed jobs counted because they may have consumed provider resources. The broker replaced every queue error with a generic rejection. A healthy broker and an idle worker therefore did not imply capacity to submit.

The versioned queue, broker and native launcher in `scripts/vps/` expose typed, allowlisted failure reasons and a read-only capacity query. The owner subsequently directed that the artificial rolling job-count and aggregate-cost quotas be removed entirely. Both admission checks are deleted, including when an old policy file still contains those fields. Historical job count and reserved cost are telemetry only, not a throttle.

The native launcher now defaults to **$1 per job and 15 minutes**, with configurable launcher arguments up to **$5 and 30 minutes**. The host bootstrap updates the ordinary user's native launcher profile to those defaults and four submission slots, with a three-hour parent timeout. The queue worker still runs one model job at a time, oldest first; the execution timeout starts when a job actually begins. There is a configurable in-flight queue bound (32 by default, up to 128), not a daily quota. There is no automatic aggregate spend cap; actual provider costs and provider-side rate/billing limits are independent. The launcher returns the broker job ID, pinned base commit and worktree. A dirty parent checkout no longer blocks submission: the isolated worktree uses the committed HEAD at submission, not uncommitted edits. Results and prompts have larger bounded payloads (12,000 and 24,000 characters respectively).

No live quota or launcher profile is changed merely by compiling the repository. The one-time bootstrap installs these versions. Legacy error messages remain recognized so old brokers can be diagnosed during migration.

## One-time administrator bootstrap

Do not grant arbitrary sudo to the MCP process or let an agent-writable script execute as root. The host account and its systemd restrictions are deliberately independent of OAuth. The following one-time bootstrap is for the host administrator over the already authorized SSH or console channel. It installs a small fixed-operation maintenance interface; future routine application restarts do not need administrator interaction.

1. In the VPS checkout, ensure there are no unrelated changes, run `npm run test:vps`, commit the desired source, and run `npm run build:vps` as the ordinary agent account. The build stamps the exact commit and SHA-256 digest of compiled JS; the server checks the stamp at startup. The previous dist tree is retained in `.mcp-state/vps-dist-previous`.
2. Check that no model jobs are queued or running and that the existing MCP services are healthy. Keep the administrator SSH connection open during bootstrap.
3. From a trusted administrator session, stage **only** the reviewed, committed artifacts under a new root-owned directory. Review the snapshot in that directory before executing anything:

```bash
# Run from the repository checkout as the authorized host administrator.
sudo install -d -o root -g root -m 0700 /root/lcp-reviewed
git archive HEAD scripts/lcp-vps-install.sh scripts/lcp-vpsctl \
  scripts/lcp-vps-health.py scripts/lcp-vps-backend-reliability.conf \
  scripts/lcp-vps-tunnel-reliability.conf scripts/vps | \
  sudo tar --extract --no-same-owner --no-same-permissions -C /root/lcp-reviewed
# Review the staged scripts and units first. No daily quota exists.
# The default in-flight queue bound is 32; the example policy is optional.
sudo bash /root/lcp-reviewed/scripts/vps/lcp-admin-install.sh
```

Use a fresh empty staging directory (if it already exists, inspect and archive it first); do not extract unreviewed code as root. The installer checks ownership/modes, backs up existing host files, stops the broker before checking for outstanding jobs, preserves queue isolation and installs the reliability migration. It starts the maintenance socket independently of the MCP. It preserves an existing operator queue policy, but the old rolling quota fields no longer have any effect. It also places npm, pnpm, pip, uv and browser-download caches in the existing writable workspace rather than the read-only home. If a later step fails, it restores the queue/broker artifacts and their active states; a successfully completed earlier tunnel migration remains in place. Preserve the reported backups and administrator access until live verification passes.

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

## Security and remaining acceptance tests

The root worker accepts only `status` and `restart(commit, receipt)`, uses fixed service identities and the installed root-owned controller, and rejects arbitrary arguments, paths and commands. It checks Unix peer credentials, bounds requests and restart frequency, and serializes restarts with the phone controller. The model worker is configured to have the maintenance socket directory hidden. Access is by the local agent UID, not a new assertion of individual OAuth caller identity. The host administrator must still review changes to privileged components; an approved/signed privileged release workflow is separate future work.

After bootstrap, verify the live capacity response has null rolling limits, a paid SAIA job with the new default budget, the actual broker capacity response, refusal of invalid maintenance requests, inability of the isolated model worker to access the socket, a real application restart with a fresh connector call and the stamped commit, and iPhone ON/OFF plus Tailscale disconnection. Hermetic tests and unit syntax checks do not establish these live results.
