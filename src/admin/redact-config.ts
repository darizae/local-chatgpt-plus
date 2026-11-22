import type { UpstreamConfigFile, UpstreamServerConfig } from "../lib/mcp-upstream-config.js";

const MASKED_ARG = "[hidden argument]";
const MASKED_URL = "[hidden URL]";
const MASKED_COMMAND = "[hidden command]";

/**
 * Browser/API responses must never expose opaque upstream credential-bearing
 * values. For a selected server, the UI can replace any field explicitly;
 * round-tripping placeholders preserves existing values in durable config.
 */
export function publicUpstreamConfig(config: UpstreamConfigFile): UpstreamConfigFile {
  return {
    version: 1,
    servers: config.servers.map((server) => ({
      ...server,
      env: Object.fromEntries(Object.keys(server.env ?? {}).map((key) => [key, ""])),
      headers: Object.fromEntries(Object.keys(server.headers ?? {}).map((key) => [key, ""])),
      args: (server.args ?? []).map(() => MASKED_ARG),
      url: server.url ? MASKED_URL : undefined,
      // Names of executables may be useful, but commands can be shell strings
      // with arbitrary embedded credentials. Do not return their contents.
      command: server.command ? MASKED_COMMAND : undefined,
    })),
  };
}

export function mergeUpstreamSecretPlaceholders(
  submitted: UpstreamServerConfig,
  previous?: UpstreamServerConfig,
): UpstreamServerConfig {
  if (!previous || submitted.id !== previous.id) return submitted;
  const merge = (next: Record<string, string> | undefined, old: Record<string, string> | undefined) =>
    next === undefined ? { ...old } : Object.fromEntries(Object.entries(next).map(([key, value]) => [
      key,
      value === "" && old && Object.prototype.hasOwnProperty.call(old, key) ? old[key] : value,
    ]));
  return {
    ...submitted,
    env: merge(submitted.env, previous.env),
    headers: merge(submitted.headers, previous.headers),
    args: submitted.args === undefined ? previous.args : submitted.args.map((arg, i) =>
      arg === MASKED_ARG ? previous.args?.[i] ?? "" : arg),
    url: submitted.url === MASKED_URL ? previous.url : submitted.url,
    command: submitted.command === MASKED_COMMAND ? previous.command : submitted.command,
  };
}
