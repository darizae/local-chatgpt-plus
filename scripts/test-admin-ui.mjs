import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "public/ui/index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "public/ui/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public/ui/styles.css"), "utf8");
const glossJs = fs.readFileSync(path.join(root, "public/ui/action-glossary.js"), "utf8");

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

function declaredUiIds() {
  const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
  for (const match of js.matchAll(/\bid=["']([^"']+)["']/g)) ids.add(match[1]);
  return ids;
}

test("Admin UI JavaScript parses", () => {
  // Parsing only: the browser globals are intentionally not executed in Node.
  new Function(js);
});

test("Activity stream reconnects after wake and transient failures", () => {
  for (const expected of [
    "function scheduleActivityReconnect()", "activityReconnectAttempt", "startActivityStream({ restart: true })",
    'document.addEventListener("visibilitychange"', 'window.addEventListener("online"',
    'window.addEventListener("pageshow"', "activityEventSource !== source", "loadActivity().catch(() => {})",
    "AbortSignal.timeout(10000)", "Admin session expired — sign in to reconnect.",
  ]) {
    if (!js.includes(expected)) throw new Error(`Activity recovery missing: ${expected}`);
  }
});

test("action-glossary.js loads before app.js", () => {
  const glIdx = html.indexOf("action-glossary.js");
  const appIdx = html.indexOf("app.js");
  if (glIdx === -1) throw new Error("action-glossary.js not referenced in index.html");
  if (appIdx === -1) throw new Error("app.js not referenced in index.html");
  if (glIdx > appIdx) throw new Error("action-glossary.js must load ahead of app.js");
  new Function(glossJs); // must parse
});

test("recent and activity details render glossary description + status note", () => {
  // Overview Recent details surface the glossary in the collapsed disclosure.
  if (!js.includes("${glossaryDetails(item.tool)}")) {
    throw new Error("Overview Recent rows do not render the glossary description");
  }
  if (!js.includes("${glossaryStatusNote(item.status")) {
    throw new Error("Overview Recent rows do not render recognized status guidance");
  }
  // Activity details surface the glossary and guidance too.
  if (!js.includes("${glossaryDetails(toolName)}")) {
    throw new Error("Activity details do not render the glossary description");
  }
  if (!js.includes("glossaryStatusNote(entry.status")) {
    throw new Error("Activity details do not render recognized status guidance");
  }
  // app.js must call into the loaded glossary module (safe fallback path kept).
  if (!js.includes("window.ActionGlossary")) throw new Error("app.js does not read window.ActionGlossary");
  // Guidance only fires for recognized classifications: the module gate must exist.
  if (!js.includes('if (!note) return "";')) throw new Error("status note lacks empty fallback for unclassified statuses");
});


test("mission dashboard shows execution state instead of treating every active plan as running", () => {
  if (!js.includes('task.execution?.state') || !js.includes('task.execution?.running_worker_count')) {
    throw new Error("execution-aware mission state is not shown");
  }
  if (!js.includes('t.execution?.progress_may_be_out_of_sync')) {
    throw new Error("Git/plan reconciliation warning is not surfaced in missions attention");
  }
  if (!js.includes('Last plan update')) {
    throw new Error("task metadata time is mislabeled as verified time");
  }
});

test("literal getElementById references exist in HTML", () => {
  const ids = declaredUiIds();
  const referenced = [...js.matchAll(/document\.getElementById\(["']([^"']+)["']\)/g)]
    .map((match) => match[1]);
  const missing = [...new Set(referenced.filter((id) => !ids.has(id)))];
  if (missing.length) throw new Error(`missing id(s): ${missing.join(", ")}`);
});

test("favicon is served locally by the app (no external URL)", () => {
  const links = [...html.matchAll(/<link[^>]+rel=["']icon["'][^>]*>/g)].map((m) => m[0]);
  if (!links.length) throw new Error("no icon <link> in index.html");
  for (const link of links) {
    if (/^https?:\/\//i.test(link)) throw new Error(`external favicon URL: ${link}`);
    if (!/favicon\.svg/.test(link)) throw new Error(`icon link does not reference local favicon.svg: ${link}`);
  }
  const svg = fs.readFileSync(path.join(root, "public/ui/favicon.svg"), "utf8");
  if (!/^<svg/.test(svg.trim())) throw new Error("public/ui/favicon.svg is not an SVG");
});

test("Overview Recent tool calls render expandable sanitized details with Berlin timestamps", () => {
  if (!js.includes("function renderRecentRow")) throw new Error("missing renderRecentRow");
  if (!js.includes("function formatBerlinTimestamp")) throw new Error("missing formatBerlinTimestamp");
  if (!js.includes("Europe/Berlin")) throw new Error("missing Europe/Berlin timezone");
  if (!js.includes("CEST") || !js.includes("CET")) throw new Error("CET/CEST zone labels missing");
  if (!js.includes('class="runtime-row recent-row"')) throw new Error("recent rows are not expandable");
  if (!js.includes("activity-details hidden")) throw new Error("recent details are not collapsed by default");
  // Start/end timestamps surfaced where fields are available.
  if (!js.includes('"detail-key">start') || !js.includes('"detail-key">end')) throw new Error("start/end detail fields missing");
});

test("Overview disclosure rows are accessible buttons (keyboard + ARIA)", () => {
  // Native <button type="button"> disclosure with the ARIA expanded/controls pair.
  if (!js.includes('type="button" class="recent-toggle"')) throw new Error("recent disclosure is not a real button");
  if (!js.includes("aria-expanded=") || !js.includes('aria-controls="')) throw new Error("missing aria-expanded/aria-controls");
  if (!js.includes("recent-details-")) throw new Error("details lack stable per-row ids for aria-controls");
  // One delegated click handler on the persistent container (not per-row listeners rebuilt each render).
  if (!js.includes("function bindRecentToggle")) throw new Error("missing delegated recent-row toggle handler");
  if (!js.includes("recentContainer")) throw new Error("delegated handler not attached to #dash-recent container");
  // Keyboard focus must be visible.
  if (!css.includes(".recent-toggle:focus-visible")) throw new Error("toggle button lacks a keyboard focus-visible style");
});

test("formatBerlinTimestamp handles missing/invalid inputs and Berlin DST", () => {
  const m = js.match(/function formatBerlinTimestamp\(iso\) \{[\s\S]*?\n\}/);
  if (!m) throw new Error("cannot extract formatBerlinTimestamp");
  // Run in Node: the function only uses Intl/Date/Number (no DOM).
  const f = new Function(`${m[0]}; return formatBerlinTimestamp;`)();
  const cases = [
    [undefined, "Time unavailable"],
    [null, "Time unavailable"],
    ["", "Time unavailable"],
    ["not-a-date", "Time unavailable"],
  ];
  for (const [input, expected] of cases) {
    const got = f(input);
    if (got !== expected) throw new Error(`formatBerlinTimestamp(${String(input)}) = ${JSON.stringify(got)}; expected ${JSON.stringify(expected)}`);
  }
  // DST: July is CEST (+02), January is CET (+01); both absolute Berlin wall-clock.
  const summer = f("2026-07-15T10:00:00Z");
  if (!/CEST$/.test(summer) || !summer.startsWith("15/07/2026")) throw new Error(`summer DST wrong: ${summer}`);
  const winter = f("2026-01-15T10:00:00Z");
  if (!/CET$/.test(winter) || !winter.startsWith("15/01/2026")) throw new Error(`winter CET wrong: ${winter}`);
});

test("Overview expanded state survives the 5s runtime refresh", () => {
  // Expanded rows are keyed by the stable tool-call id so a re-render re-applies them.
  if (!js.includes("recentExpanded")) throw new Error("missing expanded-state store");
  if (!js.includes("data-recent-id=")) throw new Error("recent rows are not addressable by stable id");
  if (!js.includes('recent.slice(0, 20).map((item) => item.id)')) throw new Error("expanded-state pruning by visible ids missing");
  if (!js.includes("recentExpanded.delete(id)") || !js.includes("recentExpanded.add(id)")) throw new Error("toggle does not persist expanded state");
});

test("navigation targets existing views", () => {
  const ids = declaredUiIds();
  const targets = [...html.matchAll(/\bdata-tab=["']([^"']+)["']/g)].map((match) => match[1]);
  const missing = targets.filter((target) => !ids.has(target));
  if (missing.length) throw new Error(`missing view(s): ${missing.join(", ")}`);
});

test("runtime overview surfaces are present", () => {
  for (const id of [
    "overview-dot",
    "overview-state",
    "overview-last-tool",
    "overview-transport",
    "overview-updated",
    "dash-active-count",
    "dash-active",
    "dash-recent",
    "dash-task-count",
    "dash-agent-task",
    "dash-operation-count",
    "dash-operations",
    "dash-loop-count",
    "dash-loops",
    "dash-transaction-count",
    "dash-transactions",
    "dash-capsule-count",
    "dash-capsules",
    "dash-state-errors",
  ]) {
    if (!html.includes(`id="${id}"`)) throw new Error(`missing ${id}`);
  }
  for (const className of [".overview-hero", ".overview-split", ".runtime-row", ".status-dot.busy"]) {
    if (!css.includes(className)) throw new Error(`missing CSS ${className}`);
  }
  if (!js.includes("coding_loops")) throw new Error("runtime overview does not render coding loops");
  if (!js.includes("context_capsules")) throw new Error("runtime overview does not render context capsules");
  if (!js.includes("state_errors")) throw new Error("runtime overview does not render persistent state warnings");
  if (!js.includes("recent.slice(0, 20)")) throw new Error("runtime overview does not retain the 20 latest completed calls");
  if (css.includes("radial-gradient(circle at top left")) throw new Error("overview hero still uses the colorful status wash");
});

test("responsive UI keeps dedicated mobile layouts", () => {
  if (!css.includes("@media (max-width: 768px)")) throw new Error("missing tablet/mobile breakpoint");
  if (!css.includes("@media (max-width: 460px)")) throw new Error("missing compact mobile breakpoint");
});

test("project recovery UI only loads data on explicit review", () => {
  for (const id of ["recovery-workspace", "recovery-stale-hours", "recovery-review-btn", "recovery-review-results"]) {
    if (!html.includes('id="' + id + '"')) throw new Error("Missing recovery element: " + id);
  }
  if (!js.includes("async function reviewProjectRecovery()")) {
    throw new Error("Project-scoped recovery UI handler is missing");
  }
  if (!js.includes("new URLSearchParams({ workspace, stale_hours: hours })")) {
    throw new Error("Recovery review lacks explicit workspace and age parameters");
  }
  if (!js.includes("esc(label)") || !js.includes("esc(suggested)")) {
    throw new Error("Recovery entries are not escaped before HTML rendering");
  }
  if (!html.includes("Read-only") || html.includes('id="recovery-delete-btn"')) {
    throw new Error("Recovery panel must remain explicitly read-only");
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);