#!/usr/bin/env bash
# Authorized admin only; use reviewed /root/lcp-reviewed snapshot.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ "$(id -u)" == 0 && $# == 0 ]]
src="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
[[ "$src" == /root/lcp-reviewed/scripts/vps ]]
for f in "$src" "$src"/lcp-dev-docker* "$src"/lcp-install-rootless-docker.sh; do
  [[ ! -L "$f" && "$(stat -c %u "$f")" == 0 ]]
  mode="$(stat -c %a "$f")"; (( (8#$mode & 022) == 0 ))
done
# The existing rootful Docker daemon and its socket are not changed.
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y uidmap slirp4netns fuse-overlayfs acl
if ! getent passwd lcp-containers >/dev/null; then
  useradd --create-home --home-dir /var/lib/lcp-containers --shell /usr/sbin/nologin lcp-containers
fi
[[ "$(id -u lcp-containers)" != 0 ]]
grep -q '^lcp-containers:' /etc/subuid
grep -q '^lcp-containers:' /etc/subgid
# Only traverse private parent directories; individual repo access is explicit.
setfacl -m u:lcp-containers:--x /home/agent /home/agent/workspaces /home/agent/workspaces/projects
for f in lcp-dev-docker.service lcp-dev-docker.socket lcp-dev-docker-proxy.service; do
  install -o root -g root -m 0644 "$src/$f" "/etc/systemd/system/$f"
done
# Rootless runc needs a persistent user manager and its session bus.
uid="$(id -u lcp-containers)"
loginctl enable-linger lcp-containers
systemctl start "user@$uid.service"
test -S "/run/user/$uid/bus"
install -d -o root -g root -m 0755 /etc/systemd/system/lcp-dev-docker.service.d
printf '[Unit]\nAfter=user@%s.service\nRequires=user@%s.service\n[Service]\nEnvironment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/%s/bus\n' "$uid" "$uid" "$uid" > /etc/systemd/system/lcp-dev-docker.service.d/50-user-bus.conf
chmod 0644 /etc/systemd/system/lcp-dev-docker.service.d/50-user-bus.conf
systemctl daemon-reload
systemd-analyze verify lcp-dev-docker.service lcp-dev-docker.socket lcp-dev-docker-proxy.service
systemctl enable --now lcp-dev-docker.service lcp-dev-docker.socket
/usr/sbin/runuser -u agent -- env DOCKER_HOST=unix:///run/lcp-dev-docker.sock /usr/bin/docker info --format '{{json .SecurityOptions}}' | grep -q rootless
echo 'Rootless Docker available through /run/lcp-dev-docker.sock'
echo 'Build contexts and named volumes work without sharing the host home.'
echo 'Use the explicit per-project bind-mount grant for host paths when required.'
