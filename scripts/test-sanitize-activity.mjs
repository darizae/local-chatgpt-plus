#!/usr/bin/env node
/**
 * Server-side activity redaction boundary tests (Phase 4):
 *  - secrets embedded in command-line text and nested arguments are removed
 *    BEFORE they reach activity responses / SSE payloads;
 *  - the persisted audit file never contains synthetic credentials;
 *  - explicit-safe fields survive while raw payload/env fields are dropped.
 *
 * Run:  node scripts/test-sanitize-activity.mjs   (after `npm run build`)
 */
import { SYNTHETIC_JWT } from "./synthetic-secret-fixtures.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  redactSecretsInText,
  sanitizeDetails,
  sanitizeToolArguments,
} from "../dist/lib/sanitize-activity.js";

const SECRETS = [
  SYNTHETIC_JWT,
  "sk-abcdefghijklmnopqrstuvwxyz123456",
  "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
  "AKIAIOSFODNN7EXAMPLE",
  "xoxb-1234567890-abcdefghijkl",
];

// --- redactSecretsInText ---------------------------------------------------
for (const secret of SECRETS) {
  const text = redactSecretsInText(`curl -H "Authorization: Bearer ${secret}" --trace`);
  assert.ok(!text.includes(secret), `text leaked: ${secret}`);
  assert.match(text, /redacted/);
}
assert.equal(
  redactSecretsInText("export OMP_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456"),
  "export OMP_API_KEY=[redacted]"
);
assert.equal(redactSecretsInText("plain command --flag value"), "plain command --flag value");

// --- sanitizeToolArguments: explicit-safe allowlist -------------------------
const dropped = sanitizeToolArguments("write_file", {
  path: "/tmp/a.ts",
  content: "raw file body with\n-secret-looking text-",
  env: { OMP_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz123456" },
}) ?? {};
assert.equal(dropped.path, "/tmp/a.ts");
assert.equal(dropped.content, undefined, "raw payload field must be dropped");
assert.equal(dropped.env, undefined, "env must be dropped");

const command = sanitizeToolArguments("run_command", {
  command: `curl -H "Authorization: Bearer ${SECRETS[0]}"`,
  working_directory: "/tmp",
  timeout: 30,
}) ?? {};
assert.equal(command.working_directory, "/tmp");
assert.match(String(command.command), /redacted/);
assert.ok(!JSON.stringify(command).includes(SECRETS[0]));

const subagent = sanitizeToolArguments("subagent", {
  action: "spawn",
  label: "plot-storage",
  objective: `Inspect OCI using token ${SECRETS[0]}`,
  workspace: "/tmp/example-project",
}) ?? {};
assert.equal(subagent.label, "plot-storage");
assert.equal(subagent.workspace, "/tmp/example-project");
assert.match(String(subagent.objective), /redacted/);
assert.ok(!JSON.stringify(subagent).includes(SECRETS[0]));

const unknownTool = sanitizeToolArguments("some_new_tool", {
  path: "/safe.txt",
  password: "hunter2",
  nested: { apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456", keep: "x" },
});
const unknownJson = JSON.stringify(unknownTool);
assert.ok(unknownJson.includes("/safe.txt"), "safe path kept on unknown tool");
assert.ok(!unknownJson.includes("hunter2"), "sensitive key dropped/redacted on unknown tool");
assert.ok(!unknownJson.toLowerCase().includes("apikey"), "nested sensitive key not echoed");

// --- sanitizeDetails: generic opaque-detail redaction ----------------------
const details = sanitizeDetails({
  http_status: 200,
  command: `--token ${SECRETS[2]}`,
  credentials: { refreshToken: "abc" },
  ok: true,
  nested: { count: 3, apiKey: SECRETS[1] },
}) ?? {};
const json = JSON.stringify(details);
assert.ok(!json.includes(SECRETS[2]));
assert.ok(!json.includes(SECRETS[1]));
assert.equal(details.nested?.count, 3);
assert.equal(details.credentials?.refreshToken, "[redacted]", "sensitive key value redacted");

// --- persisted audit file never contains secrets ---------------------------
const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-redact-"));
const auditPath = path.join(auditDir, "audit.log");
process.env.AUDIT_LOG_PATH = auditPath; // must be set before audit module init
const auditLog = await import("../dist/lib/audit.js");
await auditLog.audit({
  tool: "subagent",
  action: "spawn",
  target: "/tmp/example-project",
  status: "ok",
  details: {
    objective: `resume T-016 using ${SECRETS[0]}`,
    env: { DEEPINFRA_API_KEY: SECRETS[1] },
    command: `omp run --model deepinfra ${SECRETS[3]}`,
  },
});
const persisted = fs.readFileSync(auditPath, "utf-8");
for (const secret of SECRETS) {
  assert.ok(!persisted.includes(secret), `persisted audit leaked ${secret}`);
}
assert.match(persisted, /redacted/);
// Safe fields survive for diagnosis.
assert.ok(persisted.includes("retained.tool") || persisted.includes('"tool":"subagent"'), "tool retained");
fs.rmSync(auditDir, { recursive: true, force: true });

console.log("sanitize-activity: ok");