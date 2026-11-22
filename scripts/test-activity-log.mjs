import { SYNTHETIC_JWT } from "./synthetic-secret-fixtures.mjs";
import assert from "node:assert/strict";
import { appendActivity, getRecentActivity, logMcpRequest, summarizeToolArgs } from "../dist/lib/activity-log.js";

// summarizeToolArgs
assert.equal(summarizeToolArgs("run_command", { command: "npm test" }), "npm test");
assert.equal(summarizeToolArgs("read_text_file", { path: "C:\\foo.ts" }), "C:\\foo.ts");

// append + retrieve
const before = getRecentActivity(500).length;
appendActivity({ kind: "tool", tool: "grep", status: "ok", summary: "pattern: foo" });
assert.equal(getRecentActivity(500).length, before + 1);
const latest = getRecentActivity(1)[0];
assert.equal(latest.tool, "grep");
assert.equal(latest.kind, "tool");

// logMcpRequest tools/call
logMcpRequest(
  { method: "tools/call", params: { name: "read_text_file", arguments: { path: "/tmp/x" } } },
  "sess-abc-123",
  42,
  200
);
const mcp = getRecentActivity(5).find((e) => e.kind === "mcp" && e.tool === "read_text_file");
assert.ok(mcp, "expected mcp tools/call entry");
assert.equal(mcp.client, "chatgpt");
assert.equal(mcp.duration_ms, 42);
assert.equal(mcp.summary, "/tmp/x");

// Large MCP arguments must not be retained in full by the long-lived activity feed.
const hugeContent = "x".repeat(100_000);
logMcpRequest(
  { method: "tools/call", params: { name: "write_file", arguments: { path: "/tmp/huge", content: hugeContent } } },
  "sess-large",
  10,
  200
);
const bounded = getRecentActivity(5).find((e) => e.session_id === "sess-large");
assert.ok(bounded, "expected bounded activity entry");
// The sanitization boundary drops arbitrary payload fields entirely (raw file
// content is never surfaced), while keeping an explicit safe allowlist (path).
assert.equal(bounded.details?.arguments?.content, undefined, "write_file content must not be retained");
assert.equal(bounded.details?.arguments?.path, "/tmp/huge");

// Secrets embedded in command text and tool arguments are redacted server-side.
const jwt = SYNTHETIC_JWT;
logMcpRequest(
  { method: "tools/call", params: { name: "run_command", arguments: { command: `curl -H "Authorization: Bearer ${jwt}"` } } },
  "sess-secret",
  5,
  200
);
const secretCmd = getRecentActivity(5).find((e) => e.session_id === "sess-secret");
assert.ok(secretCmd, "expected secret command activity entry");
assert.ok(!secretCmd.summary.includes(jwt), "JWT leaked in command summary");
assert.match(secretCmd.summary, /redacted/);
const argCommand = String(secretCmd.details?.arguments?.command ?? "");
assert.ok(!argCommand.includes(jwt), "JWT leaked in arguments");
assert.match(argCommand, /redacted/);

// Sensitive env values and tokens passed as tool arguments are dropped/redacted.
logMcpRequest(
  { method: "tools/call", params: { name: "start_process", arguments: { command: "npm start", env: { OMP_API_KEY: ("sk-" + "abcdefgh1234567890") } } } },
  "sess-env",
  5,
  200
);
const envCmd = getRecentActivity(5).find((e) => e.session_id === "sess-env");
assert.equal(envCmd.details?.arguments?.env, undefined, "env values must not be surfaced");
assert.ok(!JSON.stringify(envCmd.details).includes(("sk-" + "abcdefgh1234567890")));

// filter since
const all = getRecentActivity(500);
const since = all[1]?.id;
if (since) {
  const newer = getRecentActivity(500, since);
  assert.ok(newer.length < all.length);
}

// error logging with message
logMcpRequest(
  { method: "tools/call", params: { name: "write_file", arguments: { path: "/x" } } },
  "sess-err",
  2,
  400,
  "Bad Request: Server not initialized"
);
const errEntry = getRecentActivity(3).find((e) => e.status === "error" && e.tool === "write_file");
assert.ok(errEntry, "expected error activity entry");
assert.equal(errEntry.summary, "Bad Request: Server not initialized");

console.log("activity-log: ok");