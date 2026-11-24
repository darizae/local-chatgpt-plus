#!/usr/bin/env bash
# Run as ordinary agent after rootless host installation; no production changes.
set -euo pipefail
[[ "$(id -u)" != 0 && $# == 0 ]]
export DOCKER_HOST=unix:///run/lcp-dev-docker.sock
docker info --format '{{json .SecurityOptions}}' | grep -q rootless
docker compose version
name="lcp-smoke-$(date +%s)-$$"
tmp="$(mktemp -d)"
cleanup(){ docker compose -p "$name" -f "$tmp/compose.yaml" down --volumes >/dev/null 2>&1 || true; }
trap cleanup EXIT
cat >"$tmp/compose.yaml" <<'YAML'
services:
  smoke:
    image: alpine:3.22
    command: ["sh", "-c", "echo LCP_ROOTLESS_COMPOSE_OK"]
YAML
docker compose -p "$name" -f "$tmp/compose.yaml" run --rm smoke | grep LCP_ROOTLESS_COMPOSE_OK
echo 'Rootless Docker and Compose container execution verified'
