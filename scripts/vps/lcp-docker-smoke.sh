#!/usr/bin/env bash
# Run as ordinary agent after rootless host installation; no production changes.
set -euo pipefail
[[ "$(id -u)" != 0 && $# == 0 ]]
export DOCKER_HOST=unix:///run/lcp-dev-docker.sock
docker info --format '{{json .SecurityOptions}}' | grep -q rootless
docker compose version
name="lcp-smoke-$(date +%s)-$$"
tmp="$(mktemp -d)"
cleanup(){ docker compose -p "$name" -f "$tmp/compose.yaml" down --volumes >/dev/null 2>&1 || true; rm -f "$tmp/compose.yaml"; rmdir "$tmp"; }
trap cleanup EXIT
cat >"$tmp/compose.yaml" <<'YAML'
services:
  smoke:
    image: alpine:3.22
    command: ["sh", "-c", "echo LCP_ROOTLESS_COMPOSE_OK"]
YAML
# Detached execution plus logs is robust across the socket proxy's attach stream.
docker compose -p "$name" -f "$tmp/compose.yaml" up -d
cid="$(docker compose -p "$name" -f "$tmp/compose.yaml" ps -aq smoke)"
[[ "$(docker wait "$cid")" == 0 ]]
docker logs "$cid" | grep LCP_ROOTLESS_COMPOSE_OK
echo 'Rootless Docker and Compose container execution verified'
