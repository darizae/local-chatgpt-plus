#!/usr/bin/env bash
# Read-only administrator preflight. Run from reviewed staged snapshot.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ "$(id -u)" == 0 && $# == 1 && "$1" =~ ^[0-9a-f]{12}$ ]]
repo=/home/agent/workspaces/projects/local-chatgpt-plus
head="$(runuser -u agent -- /usr/bin/git -C "$repo" rev-parse --short=12 HEAD)"
[[ "$head" == "$1" ]] || { echo "Checkout does not match requested commit"; exit 1; }
runuser -u agent -- /usr/bin/python3 -I - "$repo" "$1" <<'PY'
import pathlib,json,sys
repo=pathlib.Path(sys.argv[1])
stamp=json.loads((repo/"dist/.lcp-build.json").read_text())
assert stamp.get("commit")==sys.argv[2], "compiled commit mismatch"
active=[]
for f in pathlib.Path("/home/agent/workspaces/tasks").glob("*/state.json"):
    r=json.loads(f.read_text())
    if r.get("state") in ("running","queued"): active.append(r.get("id"))
if active: raise SystemExit("Active model jobs; do not replace queue")
print("Commit stamp matches; model queue idle")
PY
for u in lcp-vps.service lcp-vps-tunnel.service lcp-agent-queue.service lcp-agent-broker.service lcp-git-push-broker.socket; do
  systemctl show "$u" -p Id -p ActiveState -p MainPID
done
printf 'Physical capacity: '; free -h | awk '/^Mem:/{print $2}'
df -h "$repo"
printf 'Rootless prerequisite binaries: '
for x in dockerd-rootless.sh rootlesskit newuidmap newgidmap slirp4netns fuse-overlayfs setfacl; do
  command -v "$x" >/dev/null && printf '%s=present ' "$x" || printf '%s=missing ' "$x"
done
printf '\n'
docker compose version
echo 'Preflight complete; no host changes made.'
