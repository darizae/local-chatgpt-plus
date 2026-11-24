#!/usr/bin/env bash
# Run once from a reviewed ROOT-OWNED snapshot, never directly from an MCP-writable checkout.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077
[[ "$(id -u)" == 0 ]] || { echo 'Authorized host administrator required.' >&2; exit 2; }
[[ $# == 0 || ( $# == 1 && "$1" == --use-example-policy ) ]] || exit 2
src="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
[[ "$src" == /root/lcp-reviewed/scripts/vps ]] || { echo 'Use the reviewed root-owned staging directory.' >&2; exit 2; }
# Never trust an executable or configuration that the coding account can modify.
for f in /root/lcp-reviewed /root/lcp-reviewed/scripts "$src" "$src"/* "$src"/../lcp-vps*; do
  [[ ! -L "$f" && "$(stat -c %u "$f")" == 0 ]]
  mode="$(stat -c %a "$f")"
  (( (8#$mode & 022) == 0 ))
done
queue=lcp-agent-queue.service
broker=lcp-agent-broker.service
socket=lcp-maintenance.socket
git_service=lcp-git-push-broker.service
git_socket=lcp-git-push-broker.socket
git_policy=/etc/lcp-vps/git-policy.json
git_old=/usr/local/libexec/lcp-git-push-broker
[[ "$(systemctl show "$queue" -p User --value)" == agent ]]
[[ "$(systemctl show "$broker" -p User --value)" == agent ]]
[[ "$(systemctl show "$queue" -p FragmentPath --value)" == "/etc/systemd/system/$queue" ]]
[[ "$(systemctl show "$broker" -p FragmentPath --value)" == "/etc/systemd/system/$broker" ]]
queue_on="$(systemctl is-active "$queue" || true)"
broker_on="$(systemctl is-active "$broker" || true)"
socket_on="$(systemctl is-active "$socket" || true)"
socket_enabled="$(systemctl is-enabled "$socket" 2>/dev/null || true)"
for state in "$queue_on" "$broker_on" "$socket_on"; do
  [[ "$state" == active || "$state" == inactive ]] || { echo 'Service state is not stable; inspect first.' >&2; exit 1; }
done

backup="$(mktemp -d /var/backups/lcp-admin.XXXXXXXX)"
sources=(lcp-agent-queue lcp-agent-queue-broker lcp-native-subagent lcp-agent-queue-client lcp-agent-queue-root.conf lcp-maintenance lcp-maintenance-client lcp-maintenance.socket lcp-maintenance@.service lcp-maintenance-tmpfiles.conf lcp-git-push-broker lcp-git-sync lcp-durable-jobs lcp-durable-jobs.service)
destinations=(/usr/local/libexec/lcp-agent-queue /usr/local/libexec/lcp-agent-queue-broker /usr/local/bin/lcp-native-subagent /usr/local/bin/lcp-agent-queue-client /etc/systemd/system/lcp-agent-queue.service.d/50-lcp-maintenance.conf /usr/local/libexec/lcp-maintenance /usr/local/bin/lcp-maintenance-client /etc/systemd/system/lcp-maintenance.socket /etc/systemd/system/lcp-maintenance@.service /etc/tmpfiles.d/lcp-maintenance.conf "$git_old" /usr/local/bin/lcp-git-sync /usr/local/libexec/lcp-durable-jobs /etc/systemd/system/lcp-durable-jobs.service)
modes=(0755 0755 0755 0755 0644 0755 0755 0644 0644 0644 0755 0755 0755 0644)
jobs_on="$(systemctl is-active lcp-durable-jobs.service || true)"
jobs_enabled="$(systemctl is-enabled lcp-durable-jobs.service 2>/dev/null || true)"
if [[ "$jobs_on" == active ]]; then
  echo 'Durable supervisor already active; leave existing jobs intact. Review its upgrade separately.' >&2
  exit 1
fi
# Preserve existing credentials, migrate the legacy hardcoded map without
# executing the old broker or reading any SSH private key.
if [[ ! -e "$git_policy" ]]; then
  /usr/bin/python3 -I - "$git_old" "$backup/git-policy.json" <<'PY'
import ast,json,pathlib,re,sys
tree=ast.parse(pathlib.Path(sys.argv[1]).read_text())
keys=None
for node in tree.body:
    if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=="REPOS" for t in node.targets):
        keys=ast.literal_eval(node.value)
owners={m.group(1) for n in ast.walk(tree) if isinstance(n,ast.Constant) and isinstance(n.value,str)
        for m in [re.fullmatch(r"https://github.com/([A-Za-z0-9_.-]+)/",n.value)] if m}
if not isinstance(keys,dict) or len(owners)!=1:
    raise SystemExit("Review existing Git credential map before migration")
pathlib.Path(sys.argv[2]).write_text(json.dumps({"owner":owners.pop(),"repo_keys":keys,"account_key":None},indent=2)+"\n")
PY
  destinations+=("$git_policy")
  sources+=("__generated_git_policy__")
  modes+=(0644)
fi
git_socket_on="$(systemctl is-active "$git_socket" || true)"
policy=/etc/lcp-vps/agent-queue-policy.json
if [[ "${1:-}" == --use-example-policy && ! -e "$policy" ]]; then
  sources+=(agent-queue-policy.example.json)
  destinations+=("$policy")
  modes+=(0644)
fi
for i in "${!destinations[@]}"; do
  if [[ -e "${destinations[i]}" ]]; then cp -a -- "${destinations[i]}" "$backup/$i"; fi
done
printf '%s\n' "${destinations[@]}" >"$backup/targets"
echo "Maintenance backup: $backup"

restore_states() {
  if [[ "$socket_on" == active ]]; then systemctl start "$socket"; fi
  if [[ "$queue_on" == active ]]; then systemctl start "$queue"; fi
  if [[ "$broker_on" == active ]]; then systemctl start "$broker"; fi
}
rollback() {
  local rc=$?
  trap - EXIT
  if (( rc == 0 )); then return; fi
  set +e
  echo "Maintenance installation failed; restoring queue and broker artifacts from $backup." >&2
  systemctl stop "$socket" "$broker" "$queue" "$git_socket" "$git_service" lcp-durable-jobs.service
  if [[ "$jobs_enabled" != enabled ]]; then systemctl disable lcp-durable-jobs.service; fi
  if [[ "$socket_enabled" != enabled ]]; then systemctl disable "$socket"; fi
  for i in "${!destinations[@]}"; do
    if [[ -e "$backup/$i" ]]; then cp -a -- "$backup/$i" "${destinations[i]}"; else rm -f -- "${destinations[i]}"; fi
  done
  systemctl daemon-reload
  if [[ "$git_socket_on" == active ]]; then systemctl start "$git_socket"; fi
  restore_states
  exit "$rc"
}

# Stop submissions, then verify no pending jobs before restarting the worker.
systemctl stop "$broker"
if ! /usr/sbin/runuser -u agent -- /usr/bin/python3 -I -c '
import glob,json,sys
for name in glob.glob("/home/agent/workspaces/tasks/*/state.json"):
    with open(name) as f: job=json.load(f)
    if job.get("state") in ("queued","running"): sys.exit(1)
'; then
  if [[ "$broker_on" == active ]]; then systemctl start "$broker"; fi
  echo 'Queue not idle or unreadable; do not interrupt active model jobs.' >&2
  exit 1
fi
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
systemctl stop "$queue" "$socket" 2>/dev/null || systemctl stop "$queue"
systemctl stop "$git_socket" "$git_service"
install -d -m 0755 /usr/local/libexec /etc/lcp-vps /etc/systemd/system/lcp-agent-queue.service.d /etc/tmpfiles.d
for i in "${!sources[@]}"; do
  source_file="$src/${sources[i]}"
  if [[ "${sources[i]}" == __generated_git_policy__ ]]; then source_file="$backup/git-policy.json"; fi
  install -o root -g root -m "${modes[i]}" "$source_file" "${destinations[i]}"
done
systemd-tmpfiles --create /etc/tmpfiles.d/lcp-maintenance.conf
systemctl daemon-reload
systemd-analyze verify "$queue" "$broker" "$socket" lcp-maintenance@.service lcp-durable-jobs.service
# Keep package installs and browser downloads inside the existing writable
# workspace. Creating these directories as agent avoids root-owned caches.
/usr/sbin/runuser -u agent -- /usr/bin/mkdir -p /home/agent/workspaces/projects/.lcp-cache
# The same author identity applies across checkouts without writing outside
# the workspace. Preserve user-selected values if already configured.
/usr/sbin/runuser -u agent -- /usr/bin/python3 -I -c '
import pathlib,subprocess
root=pathlib.Path("/home/agent/workspaces/projects")
target=root/".lcp-cache/gitconfig"
repo=root/"local-chatgpt-plus"
for k in ("user.name","user.email"):
    current=subprocess.run(["/usr/bin/git","config","--file",str(target),"--get",k],capture_output=True,text=True)
    if current.returncode==0: continue
    value=subprocess.check_output(["/usr/bin/git","-C",str(repo),"config","--local","--get",k],text=True).strip()
    subprocess.run(["/usr/bin/git","config","--file",str(target),k,value],check=True)
'
# Independent supervisor must be reachable before the new MCP starts.
systemctl enable --now lcp-durable-jobs.service
/usr/sbin/runuser -u agent -- /usr/bin/python3 -I -c '
import json,socket,time
for i in range(30):
    try:
        with socket.socket(socket.AF_UNIX) as s:
            s.settimeout(2); s.connect("/run/lcp-durable-jobs/jobs.sock")
            s.sendall(b"{\"action\":\"ping\"}\n")
            r=json.loads(s.makefile("rb").readline())
            if r.get("ok") and r.get("data",{}).get("ready"): break
    except OSError: pass
    time.sleep(1)
else: raise SystemExit("Durable job supervisor readiness failed")
'
# Install the previous tunnel-readiness migration first. Its own rollback is separate.
bash "$src/../lcp-vps-install.sh"
systemctl enable --now "$socket"
if [[ "$git_socket_on" == active ]]; then systemctl start "$git_socket"; fi
if [[ "$queue_on" == active ]]; then systemctl start "$queue"; fi
if [[ "$broker_on" == active ]]; then systemctl start "$broker"; fi
/usr/sbin/runuser -u agent -- /usr/local/bin/lcp-maintenance-client status
if [[ "$broker_on" == active ]]; then /usr/sbin/runuser -u agent -- /usr/local/bin/lcp-agent-queue-client capacity; fi
if [[ "$git_socket_on" == active ]]; then /usr/sbin/runuser -u agent -- /usr/local/bin/lcp-git-push status; fi
trap - EXIT INT TERM
# Configure the ordinary user's native launcher only after the new host broker
# is available. The user-owned profile is written as agent, never as root.
# Preserve other profile keys, but replace the obsolete bounded runner settings.
if [[ "$broker_on" == active ]]; then
  /usr/sbin/runuser -u agent -- /usr/bin/python3 -I -c '
import json, os, pathlib, tempfile
path = pathlib.Path("/home/agent/workspaces/projects/local-chatgpt-plus/profiles/subagents.json")
value = json.loads(path.read_text()) if path.exists() else {"version": 1}
value.update(enabled=True, executable="/usr/local/bin/lcp-native-subagent",
    args=["--engine","omp","--seconds","900","--cost","1.0"],
    prompt_via_stdin=True, timeout_ms=10800000, max_concurrency=4, isolation="none")
with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as f:
    json.dump(value, f, indent=2)
    f.write("\n")
    name = f.name
os.replace(name, path)
print("Native runner configured: $1/job, 900 seconds, four submission slots")
'
fi
# Apply owner-approved development capabilities after the new code starts.
# Keep the custom profile and all OS/credential boundaries. Only remove the
# legacy local Git/recursive cleanup regexes; retain host-wide operation filters.
# Save a copy before writing, under the ordinary user's ownership.
 /usr/sbin/runuser -u agent -- /usr/bin/python3 -I -c '
import json,os,pathlib,tempfile,shutil,time
path=pathlib.Path("/home/agent/.config/lcp-vps/permissions.json")
value=json.loads(path.read_text())
if value.get("profile")!="custom" or value.get("path_roots")!=["/home/agent/workspaces/projects"]:
    raise SystemExit("Unexpected permission profile; operator review required")
shutil.copy2(path,path.with_name("permissions.pre-dev-"+str(int(time.time()))+".json"))
value.update(allow_workspace_pty=True,allow_workspace_repl=True,allow_configured_upstream_tools=True)
value["command_deny_patterns"]=[p for p in value.get("command_deny_patterns",[]) if not
    (p.startswith(r"\bgit\s+(?:reset\s+--hard") or p.startswith(r"\brm\s+-[^\s]*"))]
with tempfile.NamedTemporaryFile(mode="w",dir=path.parent,delete=False) as f:
    json.dump(value,f,indent=2); f.write("\n"); name=f.name
os.replace(name,path)
'
echo 'Host bootstrap complete. Routine application restart now uses the fixed maintenance socket.'
