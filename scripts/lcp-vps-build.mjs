/** Build a clean committed checkout as agent. Never invokes sudo. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = git("rev-parse", "--short=12", "HEAD");
if (git("status", "--porcelain")) throw new Error("Commit changes before building the deployable artifact");
const state = path.join(root, ".mcp-state");
fs.mkdirSync(state, { recursive: true });
const stage = fs.mkdtempSync(path.join(state, "vps-build-"));
const previous = path.join(state, "vps-dist-previous");
const dist = path.join(root, "dist");
try {
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "--outDir", stage], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error("TypeScript build failed");
  if (git("rev-parse", "--short=12", "HEAD") !== commit || git("status", "--porcelain")) throw new Error("Checkout changed during compilation");
  const { compiledArtifactDigest } = await import(pathToFileURL(path.join(stage, "lib", "build-artifact.js")).href);
  const digest = compiledArtifactDigest(stage);
  fs.writeFileSync(path.join(stage, ".lcp-build.json"), JSON.stringify({ version: 1, commit, digest }) + "\n");
  // Preserve a previous compiled tree; if the swap fails, restore it.
  fs.rmSync(previous, { recursive: true, force: true });
  if (fs.existsSync(dist)) fs.renameSync(dist, previous);
  try { fs.renameSync(stage, dist); }
  catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, dist); throw error; }
  console.log("Compiled artifact " + commit + " sha256=" + digest);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
