#!/usr/bin/env bash
# Operator-only migration from the reviewed root-owned staging directory.
# Does not read or replace environment files, tunnel credentials, or sudo policy.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ "$(id -u)" == 0 ]] || { echo 'Run from an authorized root shell, not the MCP connector.' >&2; exit 2; }
[[ $# == 0 ]] || { echo 'Usage: lcp-vps-install.sh' >&2; exit 2; }
umask 077
src="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
[[ "$src" == /root/lcp-reviewed/scripts ]] || { echo "Use the reviewed root-owned staging directory; see docs/LINUX_VPS_OPERATIONS.md." >&2; exit 2; }
for f in /root/lcp-reviewed "$src" "$src"/lcp-vps*; do
  [[ ! -L "$f" && "$(stat -c %u "$f")" == 0 ]]
  mode="$(stat -c %a "$f")"
  (( (8#$mode & 022) == 0 ))
done
backend=lcp-vps.service
tunnel=lcp-vps-tunnel.service
units=/etc/systemd/system
backend_drop="$units/$backend.d/50-lcp-reliability.conf"
tunnel_drop="$units/$tunnel.d/50-lcp-reliability.conf"
helper=/usr/local/libexec/lcp-vps-health.py
controller=/usr/local/sbin/lcp-vpsctl
exec 9>/run/lcp-vps-control.lock
flock -x 9

# Fail closed on unexpected deployments. Preserve the existing ExecStart
# arguments verbatim (including private profile/origin options).
for unit in "$backend" "$tunnel"; do
  [[ "$(systemctl show "$unit" -p FragmentPath --value)" == "$units/$unit" ]]
  [[ "$(systemctl show "$unit" -p User --value)" == agent ]]
  [[ "$(systemctl show "$unit" -p Type --value)" == simple ]]
  drops="$(systemctl show "$unit" -p DropInPaths --value)"
  [[ -z "$drops" || "$drops" == "$units/$unit.d/50-lcp-reliability.conf" ]] || {
    echo "Unexpected drop-ins for $unit; review manually." >&2; exit 1;
  }
done
mapfile -t commands < <(sed -n 's/^ExecStart=//p' "$units/$tunnel")
[[ ${#commands[@]} == 1 && "${commands[0]}" == '/home/agent/.local/bin/tunnel-client run --profile lcp-vps '* ]] || {
  echo 'Unexpected tunnel command; review manually.' >&2; exit 1;
}
[[ -f /home/agent/workspaces/projects/local-chatgpt-plus/dist/index.js ]] || { echo 'Build the checkout as agent first.' >&2; exit 1; }

backend_state="$(systemctl show "$backend" -p ActiveState --value)"
tunnel_state="$(systemctl show "$tunnel" -p ActiveState --value)"
for state in "$backend_state" "$tunnel_state"; do
  [[ "$state" == active || "$state" == inactive ]] || { echo 'Service transition in progress; retry once stable.' >&2; exit 1; }
done
[[ "$tunnel_state" != active || "$backend_state" == active ]]
old_backend="$(systemctl show "$backend" -p MainPID --value)"
old_tunnel="$(systemctl show "$tunnel" -p MainPID --value)"
backup="$(mktemp -d /var/backups/lcp-vps-reliability.XXXXXXXX)"
targets=("$helper" "$controller" "$backend_drop" "$tunnel_drop")
for i in "${!targets[@]}"; do
  if [[ -e "${targets[i]}" ]]; then cp -a -- "${targets[i]}" "$backup/$i"; fi
done
printf '%s\n' "$backend_state" "$tunnel_state" > "$backup/active-states"
printf '%s\n' "${targets[@]}" > "$backup/targets"
echo "Backup: $backup"

restart_original_states() {
  systemctl stop "$tunnel"
  systemctl stop "$backend"
  if [[ "$backend_state" == active ]]; then systemctl start "$backend"; fi
  if [[ "$tunnel_state" == active ]]; then systemctl start "$tunnel"; fi
}
rollback() {
  local rc=$?
  trap - EXIT HUP INT TERM
  if (( rc == 0 )); then return; fi
  echo "Migration failed; restoring previous service configuration from $backup" >&2
  set +e
  systemctl stop "$tunnel" "$backend"
  for i in "${!targets[@]}"; do
    if [[ -e "$backup/$i" ]]; then cp -a -- "$backup/$i" "${targets[i]}"; else rm -f -- "${targets[i]}"; fi
  done
  systemctl daemon-reload
  restart_original_states || echo 'Rollback service startup failed; inspect journal from admin shell.' >&2
  exit "$rc"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

install -d -m 0755 /usr/local/libexec "$units/$backend.d" "$units/$tunnel.d"
install -o root -g root -m 0755 "$src/lcp-vps-health.py" "$helper"
install -o root -g root -m 0755 "$src/lcp-vpsctl" "$controller"
install -o root -g root -m 0644 "$src/lcp-vps-backend-reliability.conf" "$backend_drop"
# Replace only the literal placeholder; never eval or interpret the command.
python3 -I - "$src/lcp-vps-tunnel-reliability.conf" "$backup/tunnel.conf" "$units/$tunnel" <<'PY'
import pathlib, sys
template, output, unit = map(pathlib.Path, sys.argv[1:])
lines = [line[len("ExecStart="):] for line in unit.read_text().splitlines() if line.startswith("ExecStart=")]
assert len(lines) == 1
text = template.read_text()
assert text.count("@ORIGINAL_EXEC_START@") == 1
output.write_text(text.replace("@ORIGINAL_EXEC_START@", lines[0]))
PY
install -o root -g root -m 0644 "$backup/tunnel.conf" "$tunnel_drop"
systemctl daemon-reload
systemd-analyze verify "$backend" "$tunnel"
restart_original_states
if [[ "$backend_state" == active ]]; then
  "$helper" wait-mcp
  [[ "$(systemctl show "$backend" -p MainPID --value)" != "$old_backend" ]]
fi
if [[ "$tunnel_state" == active ]]; then
  "$helper" wait-tunnel
  [[ "$(systemctl show "$tunnel" -p MainPID --value)" != "$old_tunnel" ]]
fi
trap - EXIT HUP INT TERM
"$controller" status
echo "Migration complete. Service enablement was preserved. Backup: $backup"
