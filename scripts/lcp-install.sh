#!/usr/bin/env bash
# Install the lcp controller to ~/.local/bin/lcp and write its per-user config.
# Usage:  scripts/lcp-install.sh
#
# This is how the repo's scripts/lcp becomes the live binary on the user's
# PATH. Run it after every edit to scripts/lcp; the installed copy is a
# snapshot and does not self-update.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
STATE_DIR="${LCP_STATE_DIR:-$HOME/.local/lcp}"
CONFIG_FILE="$STATE_DIR/state/config"

mkdir -p "$BIN_DIR" "$STATE_DIR/state"
chmod 700 "$STATE_DIR" "$STATE_DIR/state"

install -m 700 "$REPO/scripts/lcp" "$BIN_DIR/lcp"

cat > "$CONFIG_FILE" <<CONF
LCP_REPO=$REPO
LCP_NODE_BIN=$(command -v node || echo /usr/local/bin/node)
LCP_TUNNEL_BIN=${LCP_TUNNEL_BIN:-/opt/homebrew/bin/tunnel-client}
LCP_TUNNEL_YAML=${LCP_TUNNEL_YAML:-$HOME/lcp-tunnel.yaml}
LCP_USER=$USER
CONF
chmod 600 "$CONFIG_FILE"

echo "installed: $BIN_DIR/lcp"
echo "config:    $CONFIG_FILE"
"$BIN_DIR/lcp" help