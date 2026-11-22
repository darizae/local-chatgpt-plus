/** Regression: bounded root/rule/import memory reads retain the legacy instructions. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-bounded-memory-"));
// The memory candidate paths are captured at module initialization. Use a
// disposable home so a developer's real global CLAUDE.md cannot alter budgets.
const originalHome = os.homedir;
os.homedir = () => tmp;
const { loadProjectMemory } = await import("../dist/lib/project-memory.js");
const { loadPathRulesForFile } = await import("../dist/lib/path-rules.js");
os.homedir = originalHome;
const source = path.join(tmp, "CLAUDE.md");
const imported = path.join(tmp, "details.md");

// Independent legacy reference for the small/medium fixtures. It intentionally
// reads complete files, so never run it on the large I/O-budget fixtures.
async function legacyExpand(content, base, visited = new Set(), depth = 0) {
  if (depth >= 4) return content;
  const out = [];
  let inFence = false;
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    const match = !inFence && line.match(/^@(~\/[^\s`]+|[^\s`]+)\s*$/);
    if (!match) {
      out.push(line);
      continue;
    }
    const resolved = path.resolve(match[1].startsWith("~/")
      ? path.join(os.homedir(), match[1].slice(2)) : path.resolve(base, match[1]));
    if (visited.has(resolved)) {
      out.push(`<!-- skipped circular import ${resolved} -->`);
      continue;
    }
    visited.add(resolved);
    try {
      const data = await fs.readFile(resolved, "utf8");
      out.push(`<!-- @import ${resolved} -->`, await legacyExpand(
        data.replace(/<!--[\s\S]*?-->/g, ""), path.dirname(resolved), visited, depth + 1));
    } catch {
      out.push(`<!-- import failed: ${resolved} -->`);
    }
  }
  return out.join("\n");
}

async function legacyResult(text, maxBytes, maxLines) {
  const full = await legacyExpand(text.replace(/<!--[\s\S]*?-->/g, ""), path.dirname(source));
  const limited = full.split(/\r?\n/).slice(0, maxLines).join("\n");
  const truncatedBytes = Buffer.byteLength(limited, "utf8") > maxBytes
    ? Buffer.from(limited, "utf8").subarray(0, maxBytes).toString("utf8") : limited;
  return {
    content: truncatedBytes.trim(),
    truncated: Buffer.byteLength(text, "utf8") > maxBytes ||
      full.split(/\r?\n/).length > maxLines || truncatedBytes.length < full.length,
  };
}

async function check(text, maxBytes, maxLines) {
  await fs.writeFile(source, text);
  const expected = await legacyResult(text, maxBytes, maxLines);
  const result = await loadProjectMemory(tmp, { maxBytes, maxLines });
  const section = result.sections.find((item) => item.path === source);
  assert.deepEqual(section ? { content: section.content, truncated: section.truncated } : null,
    expected.content ? expected : null, `bounded memory diverged from legacy for ${JSON.stringify(text.slice(0, 80))}`);
  assert.ok(result.total_bytes <= maxBytes + 2, "bundle exceeded its byte budget beyond legacy UTF-8 replacement tolerance");
}

try {
  await fs.writeFile(imported, "Imported 🧬\n@CLAUDE.md\nLast imported line\n");
  await fs.mkdir(path.join(tmp, "directory"));
  for (let depth = 1; depth <= 4; depth++) {
    await fs.writeFile(path.join(tmp, `chain${depth}.md`),
      depth === 4 ? "Deepest instruction\r\n@details.md" : `Depth ${depth}\n@chain${depth + 1}.md`);
  }
  for (const [content, bytes, lines] of [
    ["Ordinary project instructions\nSecond line\n", 1000, 50],
    ["Before <!-- comment --> after\r\nA\nB", 250, 3],
    ["Before <!-- long "+"x".repeat(32768)+" --> after\nTail", 120, 10],
    ["Before <!-- unclosed "+"x".repeat(32768), 120, 10],
    ["Unicode 🧬🧬🧬\nNext", 17, 20],
    ["@details.md\nTrailing line", 1000, 20],
    ["@details.md\nTrailing line", 80, 20],
    ["@details.md\nTrailing line", 1000, 2],
    ["@missing.md\nTrailing line", 300, 20],
    ["@directory\nTrailing line", 300, 20],
    ["@chain1.md\nEnd", 1000, 30],
    ["Header <!-- across\n" + "y".repeat(20000) + " -->@details.md", 800, 25],
    ["```\n@details.md\n```\n@details.md", 1000, 20],
    ["@details.md\n@details.md\n", 1000, 20],
    ["No space" + " ".repeat(5000), 15, 20],
  ]) await check(content, bytes, lines);

  // Rule discovery must not load entire files just to inspect frontmatter.
  const rules = path.join(tmp, ".claude", "rules");
  await fs.mkdir(rules, { recursive: true });
  await fs.writeFile(path.join(rules, "scoped.md"), "---\npaths: src/**\n---\nIgnored scoped rule\n");
  await fs.writeFile(path.join(rules, "global.md"), "---\ndescription: global\n---\nUniversal rule\n");
  const rulesBundle = await loadProjectMemory(tmp, { maxBytes: 500, maxLines: 20 });
  assert.ok(rulesBundle.sections.some((entry) => entry.path.endsWith("global.md")));
  assert.ok(!rulesBundle.sections.some((entry) => entry.path.endsWith("scoped.md")));

  // Path-scoped rules return only their first 4,000 characters. Loading a
  // huge matching rule must not read the entire file just to truncate it.
  const hugeRule = path.join(rules, "huge-scoped.md");
  await fs.writeFile(hugeRule, "---\npaths:\n  - src/**\n---\n" + "R".repeat(32 * 1024 * 1024));
  const originalRuleOpen = fs.open;
  let ruleBytesRead = 0;
  fs.open = async (...args) => {
    const handle = await originalRuleOpen(...args);
    if (path.resolve(args[0]) === hugeRule) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        ruleBytesRead += result.bytesRead;
        return result;
      };
    }
    return handle;
  };
  try {
    const matches = await loadPathRulesForFile(tmp, path.join(tmp, "src", "index.ts"));
    const large = matches.find((entry) => entry.path === hugeRule);
    assert.equal(large?.content, "R".repeat(4000));
    assert.ok(ruleBytesRead <= 16_384, `matching rule read ${ruleBytesRead} bytes`);
    const excluded = await loadPathRulesForFile(tmp, path.join(tmp, "docs", "notes.md"));
    assert.ok(!excluded.some((entry) => entry.path === hugeRule));
  } finally {
    fs.open = originalRuleOpen;
  }
  await fs.rm(hugeRule);

  // Verify actual bytes read (not only the returned text size) for both files.
  // Open handles are wrapped so a future regression to full-file reads is caught.
  const hugeBytes = 32 * 1024 * 1024;
  await fs.writeFile(source, "Root\n@details.md\n" + "R".repeat(hugeBytes));
  await fs.writeFile(imported, "Import\n" + "I".repeat(hugeBytes));
  const originalOpen = fs.open;
  const bytesRead = new Map();
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    const name = path.resolve(args[0]);
    if (name === source || name === imported) {
      const originalRead = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await originalRead(...readArgs);
        bytesRead.set(name, (bytesRead.get(name) || 0) + result.bytesRead);
        return result;
      };
    }
    return handle;
  };
  try {
    const limited = await loadProjectMemory(tmp, { maxBytes: 200, maxLines: 25 });
    const rootSection = limited.sections.find((item) => item.path === source);
    assert.ok(rootSection?.content.startsWith(`Root\n<!-- @import ${imported} -->\nImport\n`));
    assert.equal(rootSection.truncated, true);
    assert.ok((bytesRead.get(source) || Infinity) <= 16_384, "large root read exceeded prefix budget");
    assert.ok((bytesRead.get(imported) || Infinity) <= 16_384, "large import read exceeded prefix budget");
    assert.ok(limited.total_bytes <= 202);
  } finally {
    fs.open = originalOpen;
  }
  console.log("OK  bounded project memory, large imports, rule frontmatter, and legacy-equivalent truncation");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}