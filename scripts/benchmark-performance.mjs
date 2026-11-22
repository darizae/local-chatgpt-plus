/**
 * Disposable-dir MCP performance/byte baseline (backlog P1.6 / P2.2 / P2.3).
 *
 * Spawns the built server (dist/index.js) from an isolated temp cwd on random
 * ports with no live state, tunnel, credentials or real .mcp-state, then records:
 *   - cold start to /health 200 and to first tools/list 200 (ms), post-ready RSS
 *   - tools/list response bytes for slim vs full profiles
 *   - warm 50th/95th percentile latency and result bytes for read_text_file
 *     (small + large), grep, run_command, repo_intel
 *   - text-vs-structured duplication bytes for a representative tool result
 *   - admin-on vs admin-off cold-start delta (optional-import startup cost)
 *
 * Usage: node scripts/benchmark-performance.mjs [runs=<n>] [warm=<n>]
 * Reads only its own env; never touches the real checkout, ports, or state.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SERVER = path.join(root, "dist", "index.js");

const RUNS = parseInt(process.argv.find((a) => a.startsWith("runs="))?.split("=")[1] || "3", 10);
const WARM = parseInt(process.argv.find((a) => a.startsWith("warm="))?.split("=")[1] || "6", 10);
const REPS = Math.max(2, RUNS);
const WREPS = Math.max(3, WARM);

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref();
    s.once("error", rej);
    s.listen({ host: "127.0.0.1", port: 0 }, () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

async function waitUrl(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return Date.now() - start;
    } catch {}
    await new Promise((r) => setTimeout(r, 25));
  }
  return Date.now() - start; // reached timeout; caller sees >= timeout
}

async function mcpPost(base, body, sessionId) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  // MCP may wrap in SSE even for POST in older SDKs; strip event/data framing.
  let json = text;
  if (!text.trim().startsWith("{")) {
    const m = text.match(/data:(\s*)(\{.*\})/s);
    if (!m) throw new Error(`unparseable response: ${text.slice(0, 200)}`);
    json = m[2];
  }
  return { json: JSON.parse(json), headers: res.headers };
}

function stopChild(child) {
  return new Promise((resolve) => {
    // A fixture server can fail before the cleanup starts (e.g. missing
    // build output). Never hang on an exit event that already occurred.
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    let finished = false;
    const complete = () => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      child.off("exit", complete);
      child.off("error", complete);
      resolve();
    };
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2000);
    child.once("exit", complete);
    child.once("error", complete);
    try { child.kill("SIGTERM"); } catch { complete(); }
  });
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
function fmt(x) {
  return typeof x === "number" ? Math.round(x * 10) / 10 : x;
}

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "lcp-bench-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  // small file
  writeFileSync(path.join(dir, "src", "hello.ts"), `export function hello(name: string): string {\n  return \`hi \${name}\`;\n}\n`);
  // large file (~1 MiB)
  const big = "export const DATA = [" + Array.from({ length: 40000 }, (_, i) => i).join(",") + "];\n" + "// pad\n".repeat(6000);
  writeFileSync(path.join(dir, "src", "big.ts"), big);
  writeFileSync(
    path.join(dir, "permissions.json"),
    JSON.stringify({ version: 1, profile: "open" }, null, 2),
    "utf-8"
  );
  return dir;
}

async function bootServer({ profile, admin, tui, fixture }) {
  const mcpPort = await freePort();
  const adminPort = await freePort();
  const started = Date.now();
  const child = spawn(process.execPath, [SERVER], {
    cwd: fixture,
    env: {
      ...process.env,
      PORT: String(mcpPort),
      ADMIN_PORT: String(adminPort),
      MCP_TOKEN: "",
    NODE_ENV: "test",
    LCP_ALLOW_UNAUTHENTICATED_TEST_ONLY: "1",
      ADMIN_TOKEN: "lcp-test-admin-synthetic-only",
      ADMIN_PASSKEY_FILE: path.join(fixture, "admin-passkeys.json"),
      INBOUND_AUTH_MODE: "token",
      LOCAL_CODER_TUI: tui ? "on" : "off",
      LOCAL_CODER_ADMIN_ENABLED: admin ? "true" : "false",
      CHATGPT_TOOL_PROFILE: profile,
      PERMISSIONS_CONFIG: path.join(fixture, "permissions.json"),
      MCP_SESSION_RECOVERY: "false",
      CHATGPT_AUTO_APPROVE: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.resume();
  child.stdout.resume();
  const health = `http://127.0.0.1:${mcpPort}/health`;
  const tHealth = await waitUrl(health, 20000);
  // tools/list requires an initialized session on this server.
  let sessionId = null;
  try {
    const init = await mcpPost(`http://127.0.0.1:${mcpPort}`, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bench", version: "0" } } });
    sessionId = init?.headers?.get("mcp-session-id");
  } catch {}
  const listStart = Date.now();
  let tList = null;
  let listRes = null;
  try {
    const lr = await mcpPost(`http://127.0.0.1:${mcpPort}`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, sessionId);
    listRes = lr.json;
    tList = Date.now() - listStart;
  } catch {
    tList = null;
  }
  const rss = await new Promise((res) => {
    try {
      const ps = spawn("ps", ["-o", "rss=", "-p", String(child.pid)]);
      let out = "";
      ps.stdout.on("data", (d) => (out += d));
      ps.on("close", () => res(parseInt(out.trim(), 10) || 0));
    } catch {
      res(0);
    }
  });
  return { child, mcpPort, tHealth, tList, listRes, rss };
}

function listBytes(listRes) {
  const wire = JSON.stringify(listRes);
  const tools = listRes?.result?.tools ?? [];
  return { wireBytes: Buffer.byteLength(wire), tools: tools.length };
}

async function benchTool(base, sessionId, name, args, warm) {
  const lat = [];
  const bytes = [];
  for (let i = 0; i < warm; i++) {
    const t0 = Date.now();
    const res = (await mcpPost(base, { jsonrpc: "2.0", id: 100 + i, method: "tools/call", params: { name, arguments: args } }, sessionId)).json;
    lat.push(Date.now() - t0);
    const text = res?.result?.content?.[0]?.text ?? "";
    bytes.push(Buffer.byteLength(text));
  }
  return { p50: median(lat), p95: pct(lat, 95), bytesP50: median(bytes), bytesP95: pct(bytes, 95), samples: lat.length };
}

export async function main() {
  const env = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    date: new Date().toISOString(),
    runs: REPS,
    warm: WREPS,
  };

  const results = { env, cold: [], listBytes: [], tools: [], duplication: [] };

  const profiles = ["full", "slim"];
  const admins = [true, false];

  // P1.6 cold start + tools/list bytes (slim vs full, admin on/off).
  for (const admin of admins) {
    for (const profile of profiles) {
      const fixture = makeFixture();
      let best = null;
      for (let i = 0; i < REPS; i++) {
        const b = await bootServer({ profile, admin, tui: false, fixture });
        const row = { profile, admin: admin ? "on" : "off", tHealth: b.tHealth, tList: b.tList, rss: b.rss };
        results.cold.push(row);
        if (b.listRes) {
          const lb = listBytes(b.listRes);
          results.listBytes.push({ profile, admin: admin ? "on" : "off", ...lb });
        }
        await stopChild(b.child);
        if (!best || (b.tList ?? 1e9) < (best.tList ?? 1e9)) best = row;
      }
      rmSync(fixture, { recursive: true, force: true });
    }
  }

  // P1.6 warm tool latency/bytes on a single long-lived server (slim, admin off).
  {
    const fixture = makeFixture();
    const b = await bootServer({ profile: "slim", admin: false, tui: false, fixture });
    const base = `http://127.0.0.1:${b.mcpPort}`;
    const sess = await mcpPost(base, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bench", version: "0" } } });
    const sessionId = sess?.headers?.get("mcp-session-id");
    const toolTests = {
      read_small: ["read_text_file", { path: path.join(fixture, "src", "hello.ts") }],
      read_large: ["read_text_file", { path: path.join(fixture, "src", "big.ts") }],
      grep: ["grep", { pattern: "DATA", path: path.join(fixture, "src") }],
      command: ["run_command", { command: "node -e 'console.log(1+1)'", cwd: fixture }],
      repo_intel: ["repo_intel", { action: "symbol_search", query: "hello", workspace: fixture }],
    };
    for (const [k, [name, args]] of Object.entries(toolTests)) {
      try {
        const m = await benchTool(base, sessionId, name, args, WREPS);
        results.tools.push({ name: k, ...m });
      } catch (e) {
        results.tools.push({ name: k, error: e.message });
      }
    }

    // P2.3 text-vs-structured duplication on a representative result.
    const r = (await mcpPost(base, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read_text_file", arguments: { path: path.join(fixture, "src", "big.ts") } } }, sessionId)).json;
    const content = r?.result?.content?.[0]?.text ?? "";
    const textBytes = Buffer.byteLength(content);
    const structBytes = Buffer.byteLength(JSON.stringify(r?.result?.structuredContent ?? {}));
    const fullWire = Buffer.byteLength(JSON.stringify(r));
    const contentOnlyWire = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: { content: [{ type: "text", text: content }] } }));
    results.duplication.push({ textBytes, structuredBytes: structBytes, fullWire, contentOnlyWire, overheadBytes: structBytes, ratioTextToStructured: Math.round((structBytes / Math.max(1, textBytes)) * 1000) / 1000, fullVsContentOnly: Math.round((fullWire / Math.max(1, contentOnlyWire)) * 1000) / 1000 });

    await stopChild(b.child);
    rmSync(fixture, { recursive: true, force: true });
  }

  return results;
}

const __isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (__isMain) {
  const results = await main();
  const L = [];
  const push = (s = "") => L.push(s);
  push("# MCP performance/byte baseline (P1.6 / P2.2 / P2.3)");
  push("");
  push(`- Node ${results.env.node} ${results.env.platform}/${results.env.arch}, ${results.env.date}`);
  push(`- cold-start runs=${results.env.runs}, warm tool runs=${results.env.warm}`);
  push("");
  push("## Cold start to ready (ms) + post-ready RSS (KiB)");
  push("| profile | admin | t_health | t_list | rss |");
  push("|---|---|---|---|---|");
  for (const c of results.cold) push(`| ${c.profile} | ${c.admin} | ${fmt(c.tHealth)} | ${c.tList ?? "n/a"} | ${c.rss} |`);
  push("");
  push("## tools/list bytes");
  push("| profile | admin | tools | wire_bytes |");
  push("|---|---|---|---|");
  for (const lb of results.listBytes) push(`| ${lb.profile} | ${lb.admin} | ${lb.tools} | ${lb.wireBytes} |`);
  push("");
  push("## Warm tool latency (ms) + result text bytes");
  push("| tool | p50 | p95 | bytes_p50 | bytes_p95 |");
  push("|---|---|---|---|---|");
  for (const t of results.tools) {
    if (t.error) push(`| ${t.name} | error: ${t.error} | | | |`);
    else push(`| ${t.name} | ${fmt(t.p50)} | ${fmt(t.p95)} | ${fmt(t.bytesP50)} | ${fmt(t.bytesP95)} |`);
  }
  push("");
  push("## Text-vs-structured duplication (large read result)");
  for (const d of results.duplication) {
    push(`- text_bytes=${d.textBytes} structured_bytes=${d.structuredBytes} overhead_bytes=${d.overheadBytes}`);
    push(`- full_wire=${d.fullWire} content_only_wire=${d.contentOnlyWire} ratio_text_to_structured=${d.ratioTextToStructured} full_vs_content_only=${d.fullVsContentOnly}`);
  }
  console.log(L.join("\n"));
}