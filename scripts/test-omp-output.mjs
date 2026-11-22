#!/usr/bin/env node
/**
 * Regression tests for the OMP `--mode json` output consolidator
 * (src/lib/omp-output.ts). Covers the recurring failure the supervised OMP
 * worker hit: the process exits nonzero having observed real steps (tool
 * executions, DOM/ARIA reads) but without emitting a final consolidated report
 * text. The consolidator must rebuild an honest, bounded summary and set
 * `endedWithoutReport=true` instead of returning an empty/opaque result.
 *
 * The first fixture mirrors the captured T-016 OCI reconnaissance stream shape
 * (27 tool steps, 26 assistant turns, last message thinking-only, exit code 1).
 *
 * Run:  node scripts/test-omp-output.mjs
 */
import assert from "node:assert/strict";
import { parseOmpJsonOutput } from "../dist/lib/omp-output.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`OK  ${name}`); passed++; }
  catch (error) { console.error(`FAIL ${name}: ${error?.stack || error}`); failed++; }
}

const toc = { input: 200, output: 400, cost: { total: 0.01477 } };
function text(blocks, t) { return `{"type":"message_end","message":{"role":"assistant","content":[${blocks}],"usage":${JSON.stringify(toc)}}}${t || ""}\n`; }
function thinkingOnly() {
  return `{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","text":"gathering done"}]}}\n`;
}
function toolStep(n) {
  let out = "";
  for (let i = 0; i < n; i++) out += `{"type":"tool_execution_start"}\n`;
  return out;
}

// Fixture: real-world "exited 1 without a consolidated report".
const rawEnded = toolStep(27)
  + text(`{"type":"text","text":"Home region VERIFIED: Germany Central (Frankfurt), home region, active"}`)
  + text(`{"type":"thinking","text":"let me check the user menu"}`, "\n")
  + thinkingOnly()
  + `{"type":"agent_end","isTerminal":true}\n`;

test("ends-without-report fixture: rebuilds an honest bounded summary", () => {
  const r = parseOmpJsonOutput(rawEnded, 1);
  assert.ok(r, "should parse the OMP JSONL stream");
  assert.equal(r.endedWithoutReport, true);
  assert.equal(r.toolSteps, 27);
  assert.equal(r.terminal, true);
  assert.equal(r.costCents, 3, "usage summed across the 2 usage-bearing assistant messages (0.01477*2 USD) -> 3 cents");
  assert.ok(r.inputTokens > 0 && r.outputTokens > 0);
  assert.match(r.report, /exited without emitting a final report text.*exitCode=1/);
  assert.match(r.report, /Last observation before stop: Home region VERIFIED/);
  assert.equal(r.finalText, "", "no fabricated final text");
  // never presents thinking as report evidence
  assert.ok(!r.report.includes("thinking"), "report must not contain raw thinking");
});

test("normal report fixture: final text is used verbatim, not rebuilt", () => {
  const r = parseOmpJsonOutput(
    toolStep(2)
      + text(`{"type":"text","text":"intermediate step"}`, "\n")
      + text(`{"type":"text","text":"CLOUD-M16-RESOURCES: all VERIFIED, no resource created"}`)
      + `{"type":"agent_end","isTerminal":true}\n`,
    0
  );
  assert.ok(r);
  assert.equal(r.endedWithoutReport, false);
  assert.equal(r.finalText, "CLOUD-M16-RESOURCES: all VERIFIED, no resource created");
  assert.equal(r.report, r.finalText);
  assert.equal(r.toolSteps, 2);
});

test("max-cost stop (exit 3) without final text is also rebuilt honestly", () => {
  const r = parseOmpJsonOutput(toolStep(1) + text(`{"type":"text","text":"seen so far"}`) + thinkingOnly() + `{"type":"agent_end","isTerminal":true}\n`, 3);
  assert.ok(r);
  assert.equal(r.endedWithoutReport, true);
  assert.match(r.report, /exitCode=3/);
});

test("non-JSON / non-OMP output returns null (other runners untouched)", () => {
  assert.equal(parseOmpJsonOutput("plain shell stdout line\nsecond line\n", 0), null);
  assert.equal(parseOmpJsonOutput("", 0), null);
  assert.equal(parseOmpJsonOutput("not json\n", 0), null);
});

test("single-line stream without newline returns null", () => {
  assert.equal(parseOmpJsonOutput('{"type":"session"}', 0), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);