import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/server-factory.js";
import { shutdownManagedProcesses } from "../dist/tools/shell.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tmp = path.join(root, ".tool-test-tmp", "modern-tools");

let passed = 0;
let failed = 0;
function ok(name) { console.log(`OK  ${name}`); passed++; }
function fail(name, error) { console.error(`FAIL ${name}: ${error?.stack || error}`); failed++; }
async function run(name, fn) {
  try { await fn(); ok(name); } catch (error) { fail(name, error); }
}

await fs.rm(tmp, { recursive: true, force: true });
await fs.mkdir(tmp, { recursive: true });
process.env.PERMISSIONS_CONFIG = path.join(tmp, "permissions.json");
process.env.LOCAL_HOOKS_CONFIG = path.join(tmp, "hooks.json");
process.env.SUBAGENT_CONFIG = path.join(tmp, "subagents.json");
process.env.MCP_OPERATION_STATE_DIR = path.join(tmp, "operations");
process.env.MCP_PARALLEL_BATCH_STATE_DIR = path.join(tmp, "parallel-batches");

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
// Explicitly configured PERMISSIONS_CONFIG must exist at boot (fail closed when missing).
await fs.mkdir(path.dirname(process.env.PERMISSIONS_CONFIG), { recursive: true });
await fs.writeFile(process.env.PERMISSIONS_CONFIG, JSON.stringify({ version: 1, profile: "open" }), "utf-8");
const server = createMcpServer(root, 15, [root], true);
const client = new Client({ name: "modern-tools-test", version: "1.0.0" }, { capabilities: {} });
await server.connect(serverTransport);
await client.connect(clientTransport);

const call = async (name, args) => client.callTool({ name, arguments: args });

await run("new tools are exposed in slim", async () => {
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  for (const name of ["run_commands_parallel", "view_image", "pty", "subagent", "read_files", "inspect_project", "verify_project", "process_history", "repo_intel"]) {
    if (!names.has(name)) throw new Error(`${name} not exposed`);
  }
  for (const name of [
    "shell_reset", "directory_tree", "git_log", "delete_directory", "git_reset", "git_push", "mcp_call",
    "lsp", "delegate_status", "multi_edit", "delete_file", "git_add", "git_restore",
  ]) {
    if (names.has(name)) throw new Error(`${name} should remain hidden in slim`);
  }
});

await run("parallel commands overlap in time", async () => {
  const command = process.platform === "win32"
    ? (label) => `Write-Output (\"${label}:\" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); Start-Sleep -Milliseconds 500`
    : (label) => `${JSON.stringify(process.execPath)} -e "console.log('${label}:'+Date.now());setTimeout(()=>{},500)"`;
  const result = await call("run_commands_parallel", {
    concurrency: 2,
    commands: [{ command: command("A"), working_directory: tmp }, { command: command("B"), working_directory: tmp }],
  });
  const rows = result.structuredContent?.data?.results;
  if (!Array.isArray(rows) || rows.length !== 2) throw new Error(JSON.stringify(result.structuredContent));
  if (rows.some((row) => row.exit_code !== 0)) throw new Error(JSON.stringify(rows));
  const stamps = rows.map((row) => Number(/:(\d+)/.exec(row.stdout)?.[1]));
  if (stamps.some((value) => !Number.isFinite(value))) throw new Error(`timestamps missing: ${JSON.stringify(rows)}`);
  if (Math.abs(stamps[0] - stamps[1]) > 300) throw new Error(`commands did not overlap: ${stamps.join(", ")}`);
});

await run("failed parallel command is not replayed when its side effects are uncertain", async () => {
  const marker = path.join(tmp, "non-idempotent-once.txt");
  const js = `require("fs").appendFileSync(${JSON.stringify(marker)}, "x");process.exit(7)`;
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(js)}`;
  const first = await call("run_commands_parallel", {
    concurrency: 1,
    commands: [{ command, working_directory: tmp }],
  });
  const batchId = first.structuredContent?.data?.batch_id;
  if (!batchId) throw new Error("durable batch ID missing");
  const attempts = first.structuredContent?.data?.attempts;
  const replay = await call("run_commands_parallel", { batch_id: batchId, retry_failed: true });
  const data = replay.structuredContent?.data || {};
  if (data.attempts !== attempts) throw new Error("uncertain failed command was re-executed");
  if (data.failed !== 1 || data.retryable_indices?.length) {
    throw new Error("uncertain result incorrectly reported safe to retry");
  }
  const markerText = await fs.readFile(marker, "utf8");
  if (markerText !== "x") throw new Error("uncertain command executed more than once");
});

await run("run_command exposes and honors a per-call timeout", async () => {
  const listed = await client.listTools();
  const tool = listed.tools.find((item) => item.name === "run_command");
  if (!tool?.inputSchema?.properties?.timeout_seconds) {
    throw new Error("run_command timeout_seconds schema missing");
  }

  const command = process.platform === "win32" ? "Start-Sleep -Seconds 2" : "sleep 2";
  const started = Date.now();
  let timedOut = false;
  try {
    const result = await call("run_command", { command, working_directory: tmp, timeout_seconds: 1 });
    timedOut = result.isError === true && /timed out after 1s/i.test(JSON.stringify(result));
  } catch (error) {
    timedOut = /timed out after 1s/i.test(String(error));
  }
  if (!timedOut) throw new Error("run_command did not honor timeout_seconds=1");
  if (Date.now() - started > 5_000) throw new Error("timeout override took unexpectedly long");
});

await run("managed background processes are terminated by server shutdown cleanup", async () => {
  const command = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";
  const started = await call("start_process", { command, working_directory: tmp });
  const id = started.structuredContent?.data?.id;
  if (!id) throw new Error(JSON.stringify(started));
  await shutdownManagedProcesses();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const status = await call("process_status", { id });
  const row = status.structuredContent?.data?.processes?.[0];
  if (!row || row.running) throw new Error(`background process still running: ${JSON.stringify(row)}`);
});

await run("background process spawn failure stays inside the tool call", async () => {
  if (process.platform !== "win32") return;
  const previousShell = process.env.SHELL;
  process.env.SHELL = path.join(tmp, "missing", "pwsh.exe");
  let failedCleanly = false;
  try {
    const result = await call("start_process", { command: "Write-Output SHOULD_NOT_RUN", working_directory: tmp });
    failedCleanly = result.isError === true || /ENOENT|spawn/i.test(JSON.stringify(result));
  } catch (error) {
    failedCleanly = /ENOENT|spawn/i.test(String(error));
  } finally {
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
  }
  if (!failedCleanly) throw new Error("spawn failure was not reported cleanly");
  const listed = await client.listTools();
  if (!listed.tools.some((tool) => tool.name === "run_command")) {
    throw new Error("MCP server stopped responding after spawn failure");
  }
});

await run("view_image returns MCP image content", async () => {
  const png = path.join(tmp, "pixel.png");
  const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9xkAAAAASUVORK5CYII=";
  const original = Buffer.from(onePixelPng, "base64");
  await fs.writeFile(png, original);
  const result = await call("view_image", { path: png });
  const images = result.content?.filter((item) => item.type === "image") || [];
  if (result.isError || images.length !== 1 || images[0].mimeType !== "image/png") {
    throw new Error("Expected exactly one successful PNG ImageContent block");
  }
  if (!Buffer.from(images[0].data, "base64").equals(original)) {
    throw new Error("MCP image payload differs from the source file");
  }
  const metadata = result.structuredContent?.data;
  if (metadata?.bytes !== original.length || metadata?.mime_type !== "image/png") {
    throw new Error(`Incorrect image metadata: ${JSON.stringify(metadata)}`);
  }
});

await run("view_image labels supported extensions and rejects unsupported formats", async () => {
  const contents = Buffer.from("synthetic image bytes", "utf8");
  for (const [extension, expectedMime] of [
    [".PNG", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
    [".webp", "image/webp"], [".gif", "image/gif"],
  ]) {
    const file = path.join(tmp, `format${extension}`);
    await fs.writeFile(file, contents);
    const result = await call("view_image", { path: file });
    const image = result.content?.find((item) => item.type === "image");
    if (result.isError || image?.mimeType !== expectedMime || !Buffer.from(image.data, "base64").equals(contents)) {
      throw new Error(`Incorrect extension-based MIME response for ${extension}`);
    }
  }
  const svg = path.join(tmp, "unsupported.svg");
  await fs.writeFile(svg, "<svg/>");
  const result = await call("view_image", { path: svg });
  if (!result.isError || !/Unsupported image format/.test(JSON.stringify(result))) {
    throw new Error("Unsupported image extension was not rejected");
  }
});

await run("view_image rejects files larger than 5 MiB before returning image data", async () => {
  const file = path.join(tmp, "oversized.png");
  const handle = await fs.open(file, "w");
  try { await handle.truncate(5 * 1024 * 1024 + 1); }
  finally { await handle.close(); }
  const result = await call("view_image", { path: file });
  if (!result.isError || !/Image is too large/.test(JSON.stringify(result))) {
    throw new Error("Oversized image was not explicitly rejected");
  }
  if (result.content?.some((item) => item.type === "image")) {
    throw new Error("Oversized image leaked image content");
  }
});

await run("view_image respects configured path-root permissions", async () => {
  const file = path.join(tmp, "forbidden.png");
  await fs.writeFile(file, Buffer.from("synthetic"));
  const allowed = path.join(tmp, "allowed");
  await fs.mkdir(allowed, { recursive: true });
  await fs.writeFile(process.env.PERMISSIONS_CONFIG, JSON.stringify({
    version: 1, profile: "workspace", path_roots: [allowed],
  }));
  try {
    const result = await call("view_image", { path: file });
    if (!result.isError || !/Permission denied/.test(JSON.stringify(result))) {
      throw new Error("File outside configured roots was not denied");
    }
    if (result.content?.some((item) => item.type === "image")) {
      throw new Error("Denied file leaked image content");
    }
  } finally {
    await fs.writeFile(process.env.PERMISSIONS_CONFIG, JSON.stringify({ version: 1, profile: "open" }));
  }
});

await run("oversized native tool results fail explicitly before transport", async () => {
  const huge = path.join(tmp, "oversized.txt");
  await fs.writeFile(huge, "x".repeat(4 * 1024 * 1024), "utf-8");
  const result = await call("read_text_file", { path: huge });
  if (!result.isError) throw new Error(`expected transport-size error: ${JSON.stringify(result).slice(0, 500)}`);
  const text = JSON.stringify(result);
  if (!/safe transport limit|Narrow or chunk/.test(text)) throw new Error(text.slice(0, 1000));
});

const previousProfile = process.env.CHATGPT_TOOL_PROFILE;
process.env.CHATGPT_TOOL_PROFILE = "full";
const [fullClientTransport, fullServerTransport] = InMemoryTransport.createLinkedPair();
// Explicitly configured PERMISSIONS_CONFIG must exist at boot (fail closed when missing).
await fs.mkdir(path.dirname(process.env.PERMISSIONS_CONFIG), { recursive: true });
await fs.writeFile(process.env.PERMISSIONS_CONFIG, JSON.stringify({ version: 1, profile: "open" }), "utf-8");
const fullServer = createMcpServer(root, 15, [root], true);
const fullClient = new Client({ name: "modern-tools-full-test", version: "1.0.0" }, { capabilities: {} });
await fullServer.connect(fullServerTransport);
await fullClient.connect(fullClientTransport);
const fullCall = async (name, args) => fullClient.callTool({ name, arguments: args });
if (previousProfile === undefined) delete process.env.CHATGPT_TOOL_PROFILE;
else process.env.CHATGPT_TOOL_PROFILE = previousProfile;

await run("TypeScript LSP hover and definition", async () => {
  const file = path.join(tmp, "sample.ts");
  await fs.writeFile(file, "const value: number = 42;\nfunction twice(x: number){ return x * 2; }\nconsole.log(twice(value));\n");
  const hover = await fullCall("lsp", { action: "hover", path: file, line: 3, column: 20 });
  const hoverText = JSON.stringify(hover.structuredContent?.data?.result || null);
  if (!hoverText.includes("value") || !hoverText.includes("number")) throw new Error(hoverText);
  const definition = await fullCall("lsp", { action: "definition", path: file, line: 3, column: 20 });
  const defText = JSON.stringify(definition.structuredContent?.data?.result || null);
  if (!defText.includes("sample.ts")) throw new Error(defText);
  await fullCall("lsp", { action: "shutdown", server: "typescript" });
});

await run("Python LSP hover and definition", async () => {
  const file = path.join(tmp, "sample.py");
  await fs.writeFile(file, "value: int = 42\ndef twice(x: int) -> int:\n    return x * 2\nprint(twice(value))\n");
  const hover = await fullCall("lsp", { action: "hover", path: file, line: 4, column: 13 });
  const hoverText = JSON.stringify(hover.structuredContent?.data?.result || null);
  if (!hoverText.includes("value")) throw new Error(hoverText);
  const definition = await fullCall("lsp", { action: "definition", path: file, line: 4, column: 13 });
  const defText = JSON.stringify(definition.structuredContent?.data?.result || null);
  if (!defText.includes("sample.py")) throw new Error(defText);
  await fullCall("lsp", { action: "shutdown", server: "pyright" });
});

await run("PTY provides interactive terminal I/O", async () => {
  const started = await call("pty", { action: "start", working_directory: tmp, cols: 100, rows: 30 });
  const id = started.structuredContent?.data?.id;
  if (!id) throw new Error(JSON.stringify(started.structuredContent));
  try {
    await call("pty", { action: "read", id, wait_ms: 350, strip_ansi: true });
    const command = process.platform === "win32" ? "Write-Output PTY_TOOL_OK" : "echo PTY_TOOL_OK";
    await call("pty", { action: "write", id, input: command, append_newline: true });
    const output = await call("pty", {
      action: "read",
      id,
      wait_for: "PTY_TOOL_OK",
      wait_ms: 5000,
      strip_ansi: true,
    });
    const text = output.structuredContent?.data?.output || "";
    if (!text.includes("PTY_TOOL_OK")) throw new Error(`PTY output missing marker: ${JSON.stringify(text)}`);
    await call("pty", { action: "write", id, input: "exit", append_newline: true });
    await new Promise((resolve) => setTimeout(resolve, 350));
  } finally {
    await call("pty", { action: "stop", id }).catch(() => {});
  }
});

await fullCall("lsp", { action: "shutdown" }).catch(() => {});
await fullClient.close().catch(() => {});
await fullServer.close().catch(() => {});
await client.close().catch(() => {});
await server.close().catch(() => {});
await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);