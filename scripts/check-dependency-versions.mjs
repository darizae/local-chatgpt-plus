/**
 * Read-only dependency-version check for Local ChatGPT Plus.
 *
 * Compares the installed/runtime version of every runtime-critical component
 * against the latest STABLE upstream release, without installing, mutating or
 * upgrading anything. It is safe to run on the live service and is the
 * repeatable check referenced by the recurring dependency-maintenance task in
 * MAINTENANCE_BACKLOG.md.
 *
 * Usage:
 *   node scripts/check-dependency-versions.mjs [--json]
 *
 * Exit code: 0 when every checked component is current (or newer than latest,
 * which is reported as current and not a failure); 1 when any is behind.
 * Prerelease tags (alpha/beta/rc/nightly) are never reported as a target.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fetchLatest(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`registry ${pkg} -> HTTP ${res.status}`);
  const body = await res.json();
  const latest = body?.["dist-tags"]?.latest;
  if (typeof latest !== "string") throw new Error(`no dist-tags for ${pkg}`);
  return { latest, stable: latest };
}

function installedVersion(pkg) {
  try {
    const p = path.join(root, "node_modules", ...pkg.split("/"), "package.json");
    return JSON.parse(readFileSync(p, "utf8")).version;
  } catch {
    // May not be in the project tree (e.g. globally installed CLIs).
    return null;
  }
}

const VERSION_TOKEN = /([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)/;

function execVersion(bin, args = ["--version"]) {
  try {
    const out = execFileSync(bin, args, { encoding: "utf8", timeout: 20_000 }).trim();
    const m = out.match(VERSION_TOKEN);
    return m ? m[1] : out;
  } catch {
    return null;
  }
}

const compare = (installed, latest) => {
  // Coerce loose versions to a comparable [major, minor, patch].
  const nums = (v) => (typeof v !== "string" ? [0, 0, 0] : String(v).replace(/^[^0-9]*/, "").split(/[^0-9]+/).slice(0, 3).map((n) => Number(n) || 0));
  const a = nums(installed), b = nums(latest);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? "newer" : "behind";
  }
  return "current";
};

const rows = [];

async function checkNpm(packageName, kind) {
  let stable;
  try { ({ stable } = await fetchLatest(packageName)); }
  catch (e) { rows.push({ name: packageName, kind, installed: "?", latest: "?", state: "error", note: e.message }); return; }
  const installed = installedVersion(packageName);
  const cmp = compare(installed, stable);
  rows.push({ name: packageName, kind, installed: installed ?? "?", latest: stable, state: cmp, note: cmp === "behind" ? "" : "" });
}

// Runtime-critical npm dependencies (directly used by Local ChatGPT Plus).
// `typescript-lsp` is an alias (`npm:typescript@^…`); `typescript` covers it.
const projectPkgs = ["@modelcontextprotocol/sdk", "cors", "dotenv", "express",
  "jose", "node-pty", "pyright", "typescript-language-server",
  "zod", "tsx", "typescript"];

// Globally installed computer-use providers.
const cliPkgs = ["agent-desktop", "agent-browser"];

const jsonOut = process.argv.includes("--json");

const pkgjson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

// npm-managed project dependencies.
for (const p of projectPkgs) {
  await checkNpm(p, "npm-dep");
}

// Globally installed CLIs: compare executable version to latest npm stable.
for (const p of cliPkgs) {
  let stable;
  try { ({ stable } = await fetchLatest(p)); }
  catch (e) { rows.push({ name: p, kind: "global-cli", installed: execVersion(p) ?? "?", latest: "?", state: "error", note: e.message }); continue; }
  const installed = execVersion(p) ?? "?";
  const cmp = compare(installed, stable);
  rows.push({ name: p, kind: "global-cli", installed, latest: stable, state: cmp });
}

// Node.js vs engines requirement.
const nodeVersion = process.version.replace(/^v/, "");
const engineRange = pkgjson?.engines?.node ?? "";
rows.push({ name: "node", kind: "engine", installed: nodeVersion, latest: engineRange, state: "info", note: `engines: ${engineRange} (range, not a single stable target)` });

// Externally provisioned runtime executables (reported; no single upstream tag).
for (const { name, bin, args } of [
  { name: "tunnel-client", bin: "tunnel-client", args: ["--version"] },
  { name: "ffmpeg (agent-browser recorder)", bin: "ffmpeg", args: ["-version"] },
  { name: "git", bin: "git", args: ["--version"] },
]) {
  const v = execVersion(bin, args);
  rows.push({ name, kind: "external", installed: v ?? "NOT FOUND", latest: "external", state: v ? "current" : "missing", note: v ? "check upstream release notes for the maintained channel" : "required for the referenced feature" });
}

// Summarize.
const behind = rows.filter((r) => r.state === "behind");
const errors = rows.filter((r) => r.state === "error");
const missing = rows.filter((r) => r.state === "missing");

if (jsonOut) {
  console.log(JSON.stringify({ generated_at: new Date().toISOString(), behind: behind.length, errors: errors.length, rows }, null, 2));
} else {
  const w = (s, n) => String(s ?? "").padEnd(n);
  console.log(w("component", 34) + w("kind", 16) + w("installed", 14) + w("latest stable / target", 24) + "state" + (behind.length || errors.length || missing.length ? "   note" : ""));
  for (const r of rows) {
    console.log(w(r.name, 34) + w(r.kind, 16) + w(r.installed, 14) + w(r.latest, 24) + r.state + (r.note ? `   ${r.note}` : ""));
  }
  console.log(`\n${rows.length} components checked; ${behind.length} behind stable, ${errors.length} errors, ${missing.length} missing.`);
}

if (behind.length || errors.length || missing.some((m) => m.name === "tunnel-client")) {
  process.exit(1);
}