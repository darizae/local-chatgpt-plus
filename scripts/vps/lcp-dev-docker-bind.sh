#!/usr/bin/env bash
# Ordinary agent: grant the dedicated rootless identity access to ONE repository.
# Admin first grants traverse-only ACL on the three private parent directories.
set -euo pipefail
[[ "$(id -u)" != 0 && $# == 1 ]]
root=/home/agent/workspaces/projects
project="$(realpath -e -- "$1")"
[[ "$project" == "$root/"* && "$project" != "$root/.lcp-cache"* && -e "$project/.git" ]]
# Do not follow symlinks out of the tree.
find "$project" -xdev -type d -exec setfacl -m u:lcp-containers:rwx,d:u:lcp-containers:rwx {} +
find "$project" -xdev -type f -exec setfacl -m u:lcp-containers:rw {} +
echo "Rootless Docker bind access granted for $project"
