#!/usr/bin/env bash
# Run only from a reviewed admin shell. No private key ever enters ChatGPT.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ "$(id -u)" == 0 && $# -ge 1 ]]
src="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
[[ "$src" == /root/lcp-reviewed/scripts/vps ]]
keyname=lcp_github_account_ed25519
key=/home/agent/.ssh/$keyname
policy=/etc/lcp-vps/git-policy.json
case "$1" in
  create)
    [[ $# == 1 ]]
    if runuser -u agent -- /usr/bin/test -e "$key"; then
      runuser -u agent -- /usr/bin/test -f "$key.pub" || { echo 'Existing key has no public counterpart; review before continuing'; exit 1; }
    else
      runuser -u agent -- /usr/bin/ssh-keygen -q -t ed25519 -N '' -C 'LCP VPS GitHub authentication' -f "$key" </dev/null
    fi
    echo 'Add the following PUBLIC key as an authentication key in GitHub account Settings > SSH and GPG keys.'
    runuser -u agent -- /bin/cat "$key.pub"
    ;;
  activate)
    [[ $# == 2 && "$2" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$ ]]
    # Verify the key really authenticates against an existing intended repo
    # before activating. Use the already trusted GitHub known_hosts entry.
    owner="$(/usr/bin/python3 -I - "$policy" <<'PY'
import json,pathlib,re,sys
p=pathlib.Path(sys.argv[1]); s=p.lstat()
assert not p.is_symlink() and s.st_uid==0 and not s.st_mode&0o022
owner=json.loads(p.read_text())["owner"]
assert re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}",owner)
print(owner)
PY
)"
    runuser -u agent -- /usr/bin/env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
      "GIT_SSH_COMMAND=/usr/bin/ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/home/agent/.ssh/known_hosts -o BatchMode=yes" \
      /usr/bin/git ls-remote "git@github.com:$owner/$2.git" >/dev/null
    /usr/bin/python3 -I - "$policy" "$keyname" <<'PY'
import json,os,pathlib,shutil,sys,tempfile,time
p=pathlib.Path(sys.argv[1]); s=p.lstat()
assert not p.is_symlink() and s.st_uid==0 and not s.st_mode&0o022
v=json.loads(p.read_text())
shutil.copy2(p,p.with_name("git-policy.pre-account-"+str(int(time.time()))+".json"))
v["account_key"]=sys.argv[2]
with tempfile.NamedTemporaryFile(mode="w",dir=p.parent,delete=False) as f:
    json.dump(v,f,indent=2); f.write("\n"); f.flush(); os.fsync(f.fileno()); tmp=f.name
os.chmod(tmp,0o644); os.replace(tmp,p)
PY
    runuser -u agent -- /usr/local/bin/lcp-git-sync status
    echo 'Account credential activated; existing repo-specific mappings retain precedence.'
    ;;
  *) echo "Usage: $0 create | activate EXISTING_AUTHORIZED_REPO" >&2; exit 2;;
esac
