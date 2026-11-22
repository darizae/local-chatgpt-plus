// Pure-module tests for public/ui/action-glossary.js (deterministic glossary).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "public/ui/action-glossary.js"), "utf8");
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "action-glossary.js" });
const G = sandbox.ActionGlossary;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`OK  ${name}`);
    passed++;
  } catch (error) {
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
}

// Every native tool in the registry (src/lib/tool-profile.ts LOCAL_TOOL_CATALOG)
// must have a glossary entry so the Admin UI never silently falls back.
function catalogToolNames() {
  const ts = fs.readFileSync(path.join(root, "src/lib/tool-profile.ts"), "utf8");
  const m = ts.match(/LOCAL_TOOL_CATALOG = \[([\s\S]*?)\] as const;/);
  if (!m) throw new Error("cannot parse LOCAL_TOOL_CATALOG");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

test("glossary covers every registered native tool", () => {
  const missing = catalogToolNames().filter((t) => !G.isKnown(t));
  if (missing.length) throw new Error(`missing glossary entries: ${missing.join(", ")}`);
});

test("glossary covers observed live tools and MCP session actions", () => {
  const observed = [
    "run_command", "computer_observe", "edit_file", "run_commands_parallel",
    "computer_act", "start_process", "read_files", "read_text_file",
    "load_path_rules", "subagent", "initialize", "tools/list", "tools/call",
  ];
  const missing = observed.filter((t) => !G.isKnown(t));
  if (missing.length) throw new Error(`observed tool(s) not in glossary: ${missing.join(", ")}`);
});

test("descriptions and side-effect classes are deterministic", () => {
  const cases = [
    ["run_command", "run", true],
    ["run_commands_parallel", "run", true],
    ["read_text_file", "read", false],
    ["edit_file", "write", false],
    ["start_process", "process", true],
    ["subagent", "run", true],
    ["computer_observe", "observe", false],
    ["computer_act", "computer", true],
    ["git_commit", "git", false],
    ["mcp_call", "network", false],
  ];
  for (const [tool, sideKey, danger] of cases) {
    const d = G.describe(tool);
    if (d.side.key !== sideKey || d.side.danger !== danger) {
      throw new Error(`${tool}: expected side ${sideKey} danger ${danger}, got ${d.side.key}/${d.side.danger}`);
    }
    if (!d.verb || !d.detail) throw new Error(`${tool}: missing verb/detail`);
  }
});

test("unknown tools fall back to a safe static description (no command echo)", () => {
  const d = G.describe("definitely_not_a_real_tool_99");
  if (!/unknown/i.test(d.detail)) throw new Error("unknown fallback should say behavior is unknown");
  if (d.side.key !== "unknown") throw new Error("unknown fallback must not claim a read-only effect");
  if (G.isKnown("definitely_not_a_real_tool_99")) throw new Error("unknown should not be known");
});

test("descriptions never embed commands, secrets or unbounded payloads", () => {
  const list = catalogToolNames();
  for (const t of list) {
    const d = G.describe(t);
    if (/(--[\w-]+|sk-|ghp_|Bearer |BEGIN [A-Z ]*PRIVATE KEY|\$ENV|\{\{)/.test(d.detail)) {
      throw new Error(`${t} detail may embed command/secret text: ${d.detail}`);
    }
    if (d.detail.length > 160) throw new Error(`${t} detail too long: ${d.detail}`);
  }
});

test("statusGuidance: HTTP transport status is distinct from tool effect", () => {
  const g = G.statusGuidance;
  if (g("ok", null) !== null) throw new Error("ok should yield no guidance");
  if (g("", null) !== null) throw new Error("empty status should yield no guidance");
  if (g(undefined, null) !== null) throw new Error("undefined status should yield no guidance");
  const c500 = g("error", 502);
  if (!/HTTP 502/.test(c500) && !/transport/i.test(c500)) throw new Error(`5xx note missing: ${c500}`);
  if (!/effect/.test(c500.toLowerCase()) && !/local effect/.test(c500.toLowerCase())) {
    throw new Error("5xx note must separate transport from tool effect");
  }
  if (!/access/i.test(g("error", 403))) throw new Error("403 should be classified as access failure");
  if (!/rate/.test(g("error", 429))) throw new Error("429 should be classified as rate-limited");
});

test("statusGuidance: blocked and tool-error classifications", () => {
  const b = G.statusGuidance("blocked", null);
  if (!b || !/blocked|policy|permission/i.test(b)) throw new Error(`blocked note: ${b}`);
  const e = G.statusGuidance("error", null);
  if (!e || !/failed/i.test(e)) throw new Error(`error note: ${e}`);
  // Unrecognized status must not invent guidance.
  if (G.statusGuidance("weird", null) !== null) throw new Error("unknown status should yield no guidance");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);