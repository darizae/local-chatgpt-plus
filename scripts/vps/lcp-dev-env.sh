# Source from an ordinary Aruba workspace shell. No privilege changes.
export LCP_DEV_CACHE=/home/agent/workspaces/projects/.lcp-cache
export XDG_CACHE_HOME="$LCP_DEV_CACHE"
export npm_config_cache="$LCP_DEV_CACHE/npm"
export XDG_DATA_HOME="$LCP_DEV_CACHE/data"
export PIP_CACHE_DIR="$LCP_DEV_CACHE/pip"
export UV_CACHE_DIR="$LCP_DEV_CACHE/uv"
export PLAYWRIGHT_BROWSERS_PATH="$LCP_DEV_CACHE/playwright"
export PATH="/usr/local/bin:/usr/bin:/bin:/home/agent/.local/bin:$LCP_DEV_CACHE/tools/node_modules/.bin:$PATH"
export GIT_CONFIG_GLOBAL="$LCP_DEV_CACHE/gitconfig"
if [ -S /run/lcp-dev-docker.sock ]; then export DOCKER_HOST=unix:///run/lcp-dev-docker.sock; fi
mkdir -p "$LCP_DEV_CACHE"
