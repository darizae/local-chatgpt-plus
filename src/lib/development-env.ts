/** A developer subprocess gets tooling settings, not MCP or provider tokens. */
export function developmentChildEnvironment(parent: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
    "LANG", "LANGUAGE", "TERM", "COLORTERM", "TZ", "SYSTEMROOT", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
    "npm_config_cache", "npm_config_store_dir", "PIP_CACHE_DIR", "UV_CACHE_DIR",
    "PLAYWRIGHT_BROWSERS_PATH", "GIT_CONFIG_GLOBAL", "DOCKER_HOST"]);
  return Object.fromEntries(Object.entries(parent).filter(([key, value]) =>
    typeof value === "string" && (allowed.has(key) || /^LC_[A-Z_]+$/.test(key)))) as Record<string, string>;
}
