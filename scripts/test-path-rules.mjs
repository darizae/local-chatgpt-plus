/** P1.8: path-scoped rule compatibility + security fixture tests (disposable root). */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPathRulesForFile } from "../dist/lib/path-rules.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lcp-path-rules-"));
const rules = path.join(tmp, ".claude", "rules");
await fs.mkdir(rules, { recursive: true });

async function writeRule(name, frontmatterPaths, body) {
  const pathsBlock = (frontmatterPaths || []).map((p) => `  - ${p}`).join("\n");
  await fs.writeFile(path.join(rules, name),
    `---\npaths:\n${pathsBlock}\n---\n${body}`);
}

let passed = 0;
let failed = 0;
function ok(name) { console.log(`OK  ${name}`); passed++; }
async function run(name, fn) {
  try { await fn(); ok(name); } catch (err) { failed++; console.error(`FAIL ${name}: ${err.message || err}`); }
}

await run("deterministic rule order (a,b,c regardless of readdir order)", async () => {
  await writeRule("b.md", ["src/**"], "BODY b");
  await writeRule("a.md", ["src/**"], "BODY a");
  await writeRule("c.md", ["src/**"], "BODY c");
  const matches = await loadPathRulesForFile(tmp, path.join(tmp, "src", "index.ts"));
  const names = matches.map((m) => path.basename(m.path));
  assert.deepEqual(names, ["a.md", "b.md", "c.md"], `unexpected rule order ${JSON.stringify(names)}`);
});

await run("glob compatibility: **, *, ?, brace patterns and negation-free matching", async () => {
  await writeRule("glob.md", ["src/**", "lib/??.ts", "{config,tools}/**"], "GLOB");
  const keep = [];
  for (const [rel, shouldMatch] of [
    ["src/a/b/c.ts", true], ["src/index.ts", true], ["docs/x.md", false],
    ["lib/ab.ts", true], ["lib/abc.ts", false],
    ["config/app.json", true], ["tools/build.ts", true], ["public/x.ts", false],
  ]) {
    const matches = await loadPathRulesForFile(tmp, path.join(tmp, rel));
    const hit = matches.some((m) => path.basename(m.path) === "glob.md");
    if (hit !== shouldMatch) keep.push(`expected ${rel} match=${shouldMatch} got ${hit}`);
  }
  if (keep.length) throw new Error(keep.join("; "));
});

await run("Unicode filenames in rules and target paths", async () => {
  await writeRule("unic.md", ["src/日本語/**", "data/école/*.md"], "UNI");
  const hit1 = await loadPathRulesForFile(tmp, path.join(tmp, "src", "日本語", "f.ts"));
  const hit2 = await loadPathRulesForFile(tmp, path.join(tmp, "data", "école", "n.md"));
  const miss = await loadPathRulesForFile(tmp, path.join(tmp, "src", "other", "f.ts"));
  if (!hit1.some((m) => path.basename(m.path) === "unic.md") ||
      !hit2.some((m) => path.basename(m.path) === "unic.md") ||
      miss.some((m) => path.basename(m.path) === "unic.md")) {
    throw new Error("unicode glob matching failed");
  }
});

await run("CRLF frontmatter is parsed and matched", async () => {
  await fs.writeFile(path.join(rules, "crlf.md"), "---\r\npaths:\r\n  - src/**\r\n---\r\nCRLF BODY\r\n");
  const matches = await loadPathRulesForFile(tmp, path.join(tmp, "src", "x.ts"));
  const rule = matches.find((m) => path.basename(m.path) === "crlf.md");
  assert.ok(rule, "CRLF rule not matched");
  assert.equal(rule.content.trim(), "CRLF BODY");
});

await run("long (multi-chunk) frontmatter still parsed; body capped at 4,000 chars", async () => {
  // Header larger than the 8 KB read buffer exercises the chunked header path.
  const filler = "description: " + "y".repeat(20 * 1024) + "\n";
  const body = "Z".repeat(10_000);
  await fs.writeFile(path.join(rules, "long.md"),
    `---\npaths:\n  - src/**\n${filler}---\n${body}`);
  const matches = await loadPathRulesForFile(tmp, path.join(tmp, "src", "a.ts"));
  const rule = matches.find((m) => path.basename(m.path) === "long.md");
  assert.equal(rule.content, "Z".repeat(4000), "long rule body not capped at 4000");
});

await run("symlinked rule directory outside the workspace is not traversed", async () => {
  const outside = path.join(tmp, "outside-rules");
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "leak.md"), "---\npaths: src/**\n---\nLEAK");
  await fs.symlink(outside, path.join(rules, "linked-dir"));
  const before = (await loadPathRulesForFile(tmp, path.join(tmp, "src", "x.ts")))
    .map((m) => path.basename(m.path));
  assert.ok(!before.includes("leak.md"), `symlinked dir leaked rule: ${JSON.stringify(before)}`);
  await fs.rm(path.join(rules, "linked-dir"));
});

await run("symlinked .md rule file outside the workspace is never loaded", async () => {
  const outside = path.join(tmp, "outside-rule.md");
  await fs.writeFile(outside, "---\npaths:\n  - src/**\n---\nSECRET_OUTSIDE");
  const link = path.join(rules, "symlink-leak.md");
  await fs.symlink(outside, link);
  try {
    const matches = await loadPathRulesForFile(tmp, path.join(tmp, "src", "x.ts"));
    assert.ok(!matches.some((m) => path.basename(m.path) === "symlink-leak.md"),
      "a symlinked rule file was loaded from outside the rules directory");
  } finally {
    await fs.rm(link);
  }
});

await run("`..`/absolute outside-path cannot inject this workspace's relative rules", async () => {
  await writeRule("scoped.md", ["src/**"], "SCOPED");
  const other = path.join(os.tmpdir(), "lcp-other-workspace-file.ts");
  const matches = await loadPathRulesForFile(tmp, other);
  assert.ok(!matches.some((m) => path.basename(m.path) === "scoped.md"),
    "outside path matched a project-relative rule");
});

await run("absolute-glob rule still matches its absolute path (compat fallback)", async () => {
  const dataDir = path.join(tmp, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const absGlob = `${dataDir.replace(/\\/g, "/")}${path.sep}**`;
  await writeRule("abs.md", [absGlob], "ABSOLUTE");
  const matches = await loadPathRulesForFile(tmp, path.join(dataDir, "deep", "f.md"));
  assert.ok(matches.some((m) => path.basename(m.path) === "abs.md"),
    "absolute-glob rule did not match its absolute path");
});

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);