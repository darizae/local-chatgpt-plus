import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoveryCandidates } from "../dist/lib/mcp-upstream-config.js";
import { resolveSafeSpawnSpec } from "../dist/lib/safe-spawn.js";
import { toolResult } from "../dist/lib/tool-result.js";
import { createToolVisibility, saveLocalToolOverrides, invalidateLocalToolOverrides, SLIM_CHATGPT_TOOLS } from "../dist/lib/tool-profile.js";
import { getLocalHooksConfig, saveLocalHooksConfig, invalidateLocalHooksConfig } from "../dist/lib/local-hooks.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(SLIM_CHATGPT_TOOLS.size, 42, "macOS cleanup must preserve the default tool profile");
const adminRoutes = await fs.readFile(path.join(root, "src/admin/routes.ts"), "utf8");
const adminUI = await fs.readFile(path.join(root, "public/ui/app.js"), "utf8");
const skillLoader = await fs.readFile(path.join(root, "src/lib/skills-loader.ts"), "utf8");
assert.ok(!adminRoutes.includes('"/api/plugins"'), "unreachable native plugin API remains");
assert.ok(!adminUI.includes("openComputerUseDialog"), "unreachable native plugin UI remains");
assert.ok(!skillLoader.includes("plugin-config.js"), "unreachable native plugin skill import remains");
await assert.rejects(fs.access(path.join(root, "src/lib/plugin-config.ts")), { code: "ENOENT" });
assert.ok(adminRoutes.includes('"/api/upstream/presets/computer-use"'), "Vercel MCP presets were lost");
assert.ok(adminUI.includes("add-computer-use-presets"), "Vercel MCP controls were lost");
const candidates = discoveryCandidates();
assert.ok(candidates.some((candidate) => candidate.path.endsWith(path.join("Library", "Application Support", "Claude", "claude_desktop_config.json"))));
assert.ok(candidates.every((candidate) => !candidate.path.includes("AppData") && !candidate.path.includes("ProgramData")));
const spec = await resolveSafeSpawnSpec("/usr/bin/env", ["printf", "untrusted; words"]);
assert.equal(spec.file, "/usr/bin/env");
assert.deepEqual(spec.args, ["printf", "untrusted; words"]);
const payload = toolResult("test", { files: ["a"] });
assert.deepEqual(JSON.parse(payload.content[0].text), payload.structuredContent);
assert.equal(payload.content[0].text.includes("\n"), false, "text fallback should be compact");

const priorCwd = process.cwd();
const priorHookPath = process.env.LOCAL_HOOKS_CONFIG;
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-macos-test-"));
try {
  await fs.mkdir(path.join(scratch, "profiles"));
  process.chdir(scratch);
  saveLocalToolOverrides({ enabled: ["lsp"], disabled: ["git_push"] });
  const visibility = createToolVisibility("slim");
  assert.equal(visibility("lsp"), true);
  assert.equal(visibility("git_push"), false);
  assert.equal(createToolVisibility("full")("git_push"), false, "explicit disables must apply even to the full profile");
  saveLocalToolOverrides({ enabled: [], disabled: ["lsp"] });
  assert.equal(createToolVisibility("slim")("lsp"), false, "admin save must invalidate overrides");
  assert.equal(visibility("lsp"), true, "existing MCP sessions keep their visibility snapshot");

  process.env.LOCAL_HOOKS_CONFIG = path.join(scratch, "hooks.json");
  await saveLocalHooksConfig({ enabled: false, hooks: [] });
  assert.equal((await getLocalHooksConfig()).enabled, false);
  await saveLocalHooksConfig({ enabled: true, hooks: [] });
  assert.equal((await getLocalHooksConfig()).enabled, true, "admin save must invalidate hook cache");
  await fs.writeFile(process.env.LOCAL_HOOKS_CONFIG, JSON.stringify({ version: 1, enabled: false, hooks: [] }));
  assert.equal((await getLocalHooksConfig()).enabled, true, "cached config should avoid an immediate extra read");
  invalidateLocalHooksConfig();
  assert.equal((await getLocalHooksConfig()).enabled, false);
  console.log("OK macOS tool count, native plugin removal, Vercel MCP preservation, config discovery, spawn, text fallback and caches");
} finally {
  process.chdir(priorCwd);
  if (priorHookPath === undefined) delete process.env.LOCAL_HOOKS_CONFIG;
  else process.env.LOCAL_HOOKS_CONFIG = priorHookPath;
  invalidateLocalToolOverrides();
  invalidateLocalHooksConfig();
  await fs.rm(scratch, { recursive: true, force: true });
}