# Aruba VPS: reliable MCP and Secure Tunnel

The VPS and phone are separate systems. Tailscale provides the phone's SSH control path, while the VPS tunnel independently polls OpenAI. Disconnecting the phone after the VPS has accepted ON must not stop the MCP or the tunnel. This does not guarantee that ChatGPT itself continues a conversational turn indefinitely.

## Failure and design

On 2026-11-24 the tunnel started before port 8766 was listening. Its startup catalog failed and control-plane polling was disabled even while the tunnel process remained alive. A successful MCP /health or tunnel process status alone is insufficient.

- Preserve the existing OAuth profile, service account, environment files, unit names and tunnel command.
- The backend is considered started only after /health responds with status ok and authMode oauth.
- The tunnel wrapper waits for MCP health before spawning the existing command. Systemd start completes only when the MCP, /readyz, and the OpenAI client's last-successful-poll metric all pass. Poll freshness is 120 seconds with 5 seconds of clock-skew tolerance. A missing metric fails closed.
- The wrapper owns its child, treats a clean unexpected exit as failure, gives startup 75 seconds, and exits after three consecutive unhealthy runtime checks (10-second cadence); systemd cleans the cgroup and retries after 15 seconds. The systemd retry rate is bounded by that delay; a persistent auth/network issue still requires operator intervention. An explicit stop does not trigger Restart=always.
- The controller uses a root-owned lock and a transient systemd service for fixed ON/OFF/pause/resume/restart actions. SSH disconnection after systemd accepts the job does not cancel it. OFF disables the services, and pause disables only the tunnel. Repeated ON repairs an unhealthy existing tunnel. The forced-command phone interface is unchanged.
- The Admin observer is opt-in via the backend drop-in. It recognizes the exact paired Linux unit and drop-in, and requires readiness plus fresh polling; it never manages the service or exposes config contents. Do not enable the in-process supervisor alongside systemd.

## Migration (operator only)

The connector account is deliberately not the host administrator. The root-owned controller, helper and drop-ins require a one-time authorized host bootstrap. Follow [Linux VPS self-service operations](LINUX_VPS_OPERATIONS.md) to install the reviewed root-owned maintenance bridge together with the reliability fix. Compile the intended commit as the unprivileged agent first, e.g. from the repository:

```bash
npm run test:vps
# Commit the reviewed changes first.
npm run build:vps
git status --short
git rev-parse --short=12 HEAD
```

Stop or finish unrelated VPS work before the restart. The installer validates existing unit names, account, startup command shape, and drop-in ownership assumptions, makes a root-only backup, installs the reviewed artifacts as root-owned files, verifies systemd configuration, stops the old service cgroups, and starts only services that had been active. It preserves boot enablement and the phone's forced-command wrapper. The original tunnel command is read from the existing root-owned unit; it is not embedded in source control. It rolls back installed service files and restores the previous active state if migration fails (the compiled application remains the newly built version).

Use the combined administrator bootstrap in [Linux VPS self-service operations](LINUX_VPS_OPERATIONS.md). It invokes the reliability installer from the reviewed root-owned snapshot. If migration fails, inspect the reported backup location and journal from the administrator console; rollback may need manual intervention if the old startup race reappears. Keep the existing SSH/console recovery channel accessible.

## Acceptance checks (after installation)

```bash
sudo /usr/local/sbin/lcp-vpsctl status
systemctl show lcp-vps.service lcp-vps-tunnel.service -p ActiveState -p MainPID -p NRestarts -p DropInPaths
/usr/local/libexec/lcp-vps-health.py tunnel
journalctl -u lcp-vps.service -n 50 --no-pager
journalctl -u lcp-vps-tunnel.service -n 50 --no-pager
```

Check the MCP startup log / agent_status runtime identity against the intended Git commit, verify the old PIDs are gone and only the systemd cgroups own the current processes, then call an actual tool through the Aruba connector in a fresh chat. Verify OFF leaves both units inactive and disabled and resume/on starts them again. Test repeated ON and restart, and disconnect the iPhone's Tailscale only after ON has been accepted. Perform intentional failures or OFF tests only with a separate authorized recovery channel; do not restart the only MCP connection from itself.

The hermetic Python and TypeScript regressions cover missing/stale poll timestamps, backend readiness, never-ready startup, runtime degradation, explicit stop, child cleanup, systemd status and dashboard rendering. These tests are not a substitute for a live installation and phone-disconnect test.
