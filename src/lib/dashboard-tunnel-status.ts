import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import type { TunnelSnapshot } from "./tunnel-supervisor.js";

const execFileAsync = promisify(execFile);
const JOB_LABEL = "com.localchatgpt.plus.tunnel";

export type DashboardTunnelSnapshot = TunnelSnapshot & {
  /** The observer is not an additional supervisor; it never starts a tunnel. */
  management: "internal" | "launchd" | "systemd" | "not_monitored";
};

interface ProbeDependencies {
  platform?: string;
  home?: string;
  uid?: number;
  now?: () => number;
  ttlMs?: number;
  launchctlPrint?: (label: string) => Promise<string>;
  readProfile?: (file: string) => Promise<string>;
  ready?: (port: number) => Promise<boolean>;
  systemdEnabled?: boolean;
  systemdShow?: () => Promise<string>;
  pollFresh?: (port: number) => Promise<boolean>;
}

type ExternalTunnel = Pick<TunnelSnapshot,
  "status" | "configured" | "health_port" | "pid" | "restarts" | "last_error">;

async function defaultLaunchctlPrint(label: string): Promise<string> {
  const { stdout } = await execFileAsync("launchctl", ["print", label], {
    timeout: 1800,
    maxBuffer: 64 * 1024,
  });
  return stdout;
}

async function defaultReady(port: number): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/readyz", {
      signal: AbortSignal.timeout(1500), redirect: "error",
    });
    if (!response.ok) return false;
    const text = await response.text();
    return /^ready\b|^ok\b/i.test(text.trim());
  } catch {
    return false;
  }
}

export function freshControlPlanePoll(metrics: string, nowSeconds: number): boolean {
  const rows = [...metrics.matchAll(/^commands_poll_last_successful_timestamp_seconds(?:\{[^\n]*\})?[ \t]+(\S+)[ \t]*$/gm)];
  if (rows.length !== 1) return false;
  const age = nowSeconds - Number(rows[0][1]);
  return Number.isFinite(age) && age >= -5 && age <= 120;
}

async function defaultPollFresh(port: number): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/metrics", {
      signal: AbortSignal.timeout(1500), redirect: "error",
    });
    return response.ok && freshControlPlanePoll(await response.text(), Date.now() / 1000);
  } catch { return false; }
}

async function defaultSystemdShow(): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/systemctl", [
    "show", "lcp-vps-tunnel.service", "-p", "LoadState", "-p", "FragmentPath",
    "-p", "DropInPaths", "-p", "ActiveState", "-p", "MainPID", "-p", "NRestarts",
  ], { timeout: 1800, maxBuffer: 16 * 1024 });
  return stdout;
}

/**
 * Read-only observation of the installed launchd job or opt-in Aruba systemd service.
 * Never treat a random listener on 8090 as the user's MCP tunnel: require
 * the exact launchd job, its configured profile, and the expected MCP target.
 * Never return raw launchctl output, profile text, paths or bearer tokens.
 */
export function createDashboardTunnelResolver(
  mcpPort: number,
  deps: ProbeDependencies = {}
): (snapshot: TunnelSnapshot | null) => Promise<DashboardTunnelSnapshot | null> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? os.homedir();
  const uid = deps.uid ?? process.getuid?.();
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 4000;
  const launchctlPrint = deps.launchctlPrint ?? defaultLaunchctlPrint;
  const readProfile = deps.readProfile ?? ((file: string) => fs.readFile(file, "utf8"));
  const ready = deps.ready ?? defaultReady;
  const systemdEnabled = deps.systemdEnabled ?? process.env.LCP_SYSTEMD_TUNNEL_MONITOR === "1";
  const systemdShow = deps.systemdShow ?? defaultSystemdShow;
  const pollFresh = deps.pollFresh ?? defaultPollFresh;

  async function observeSystemd(): Promise<ExternalTunnel | null> {
    // Opt-in is installed by the root-owned Aruba backend drop-in. Only recognize
    // the paired deployment and exact systemd unit/drop-in, never arbitrary ports.
    if (!systemdEnabled || mcpPort !== 8766) return null;
    const fields = new Map((await systemdShow()).split("\n").filter(line => line.includes("="))
      .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    if (fields.get("LoadState") !== "loaded" ||
        fields.get("FragmentPath") !== "/etc/systemd/system/lcp-vps-tunnel.service" ||
        !fields.get("DropInPaths")?.split(/\s+/).includes("/etc/systemd/system/lcp-vps-tunnel.service.d/50-lcp-reliability.conf")) return null;
    const healthPort = 8790;
    const pid = Number(fields.get("MainPID"));
    const restarts = Math.max(0, Number(fields.get("NRestarts")) || 0);
    const active = fields.get("ActiveState");
    if (active !== "active" || !Number.isSafeInteger(pid) || pid <= 0) {
      return { configured: true, health_port: healthPort, pid: null, restarts,
        status: active === "activating" ? "starting" : active === "failed" ? "degraded" : "stopped",
        last_error: "systemd tunnel is not active" };
    }
    const healthy = await ready(healthPort) && await pollFresh(healthPort);
    return { configured: true, health_port: healthPort, pid, restarts,
      status: healthy ? "online" : "degraded",
      last_error: healthy ? null : "systemd tunnel readiness or control-plane polling is unhealthy" };
  }
  let cached: ExternalTunnel | null = null;
  let cachedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<ExternalTunnel | null> | null = null;

  async function observe(): Promise<ExternalTunnel | null> {
    if (platform === "linux") return observeSystemd();
    if (platform !== "darwin" || uid == null) return null;
    const label = "gui/" + uid + "/" + JOB_LABEL;
    let info: string;
    try {
      info = await launchctlPrint(label);
    } catch {
      return null; // No verified lcp launchd job.
    }
    const expectedJobPath = path.join(home, ".local", "lcp", "launchd", JOB_LABEL + ".plist");
    if (!info.includes("path = " + expectedJobPath)) return null;
    if (!/^\s*program = .*\/tunnel-client\s*$/m.test(info)) return null;
    const argsText = /^\s*arguments = \{([\s\S]*?)^\s*\}/m.exec(info)?.[1] ?? "";
    const args = argsText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    const profileFlag = args.indexOf("--profile-file");
    if (profileFlag < 0 || !args[profileFlag + 1]) return null;
    const profileFile = args[profileFlag + 1];
    const relative = path.relative(home, profileFile);
    if (!path.isAbsolute(profileFile) || relative === ".." ||
        relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return null;
    let config: string;
    try {
      config = await readProfile(profileFile);
    } catch {
      return null;
    }
    const health = /^\s*listen_addr:\s*127\.0\.0\.1:(\d+)\s*$/m.exec(config);
    const healthPort = Number(health?.[1]);
    if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65535) return null;
    const mcpTarget = new RegExp(
      "^[ \\t]*url:\\s*['\\\"]?http://127\\.0\\.0\\.1:" + mcpPort +
      "/mcp(?:/|\\s|['\\\"]|$)", "m"
    );
    if (!mcpTarget.test(config)) return null;

    const state = /^\s*state = (\S+)/m.exec(info)?.[1];
    const pid = Number(/^\s*pid = (\d+)/m.exec(info)?.[1] ?? 0);
    const runs = Number(/^\s*runs = (\d+)/m.exec(info)?.[1] ?? 0);
    const restarts = Math.max(0, runs - 1);
    if (state !== "running" || !Number.isInteger(pid) || pid <= 0) {
      return {
        status: "stopped", configured: true, health_port: healthPort,
        pid: null, restarts, last_error: "launchd tunnel job is not running",
      };
    }
    const healthy = await ready(healthPort);
    return {
      status: healthy ? "online" : "degraded",
      configured: true,
      health_port: healthPort,
      pid,
      restarts,
      last_error: healthy ? null : "launchd tunnel health endpoint is not ready",
    };
  }

  async function externalStatus(): Promise<ExternalTunnel | null> {
    if (now() - cachedAt < ttlMs) return cached;
    if (!inflight) {
      inflight = observe().catch(() => null).then((result) => {
        cached = result;
        cachedAt = now();
        return result;
      }).finally(() => { inflight = null; });
    }
    return inflight;
  }

  return async (snapshot) => {
    if (!snapshot) return null;
    if (snapshot.managed) return { ...snapshot, management: "internal" };
    const external = await externalStatus();
    if (!external) return { ...snapshot, management: "not_monitored" };
    return {
      ...snapshot,
      ...external,
      managed: false,
      management: platform === "linux" ? "systemd" : "launchd",
      reused_external: false,
    };
  };
}
