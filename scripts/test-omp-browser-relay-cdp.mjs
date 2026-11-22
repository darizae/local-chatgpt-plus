import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerComputerUseTools } from "../dist/tools/computer-use.js";
import { allowedComputerUseTools } from "../dist/lib/computer-use-policy.js";
import { needsComputerApproval } from "../dist/lib/computer-approval.js";
import { savePermissionConfig } from "../dist/lib/permissions.js";
import { RelayCdpClient } from "../dist/lib/omp-browser-relay-cdp.js";

// ---- Minimal RFC6455 websocket framing (server side) ----------------------
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function serverFrame(payload, opcode = 0x1) {
  const body = Buffer.from(payload, "utf8");
  let head;
  if (body.length < 126) {
    head = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(body.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([head, body]);
}
function decodeClientFrame(buf) {
  const opcode = buf[0] & 0x0f;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const masked = (buf[1] & 0x80) !== 0;
  let payload;
  if (masked) {
    const mask = buf.subarray(off, off + 4); off += 4;
    payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = buf[off + i] ^ mask[i % 4];
  } else {
    payload = buf.subarray(off, off + len);
  }
  return { opcode, payload };
}

// ---- Fake `omp browser-relay` daemon emulating the real /cdp protocol ------
const TARGET = {
  id: "PAGEabc.42", type: "page", title: "Fixture Apply",
  url: "https://univers.breezy.hr/p/efa58c39933301-forward-deployed-engineer/apply",
  active: "true", discarded: "false",
};
const SESSION_ID = "page-session-0001";
const receivedExpressions = [];
let cdpConnections = 0;
// Simulated live location.href of the fixture "page". The real relay revalidates
// /json/list (discovery) and then evaluates a guarded expression on the page; the
// fixture distinguishes the two so we can emulate a TOCTOU navigation window.
let pageUrl = TARGET.url;

function evalValueFor(expression) {
  receivedExpressions.push(expression);
  // Every expression embeds the exact bound URL inside its navigation guard.
  // If that expected URL differs from the page's live location, the tab
  // navigated between /json/list discovery and evaluation: fail before acting.
  const m = /location\.href!==("(?:[^"\\]|\\.)*")/i.exec(expression);
  const expected = m ? JSON.parse(m[1]) : "";
  if (expected && expected !== pageUrl) {
    return { ok: false, error: "page navigated since binding", url: pageUrl };
  }
  if (expression.includes("innerText")) return "Relay fixture page text with APPLY button";
  if (expression.includes("return location.href;")) return pageUrl;
  if (expression.includes("document.title")) return "Fixture Apply";
  if (expression.includes('"#missing"')) return { ok: false, error: "selector not found" };
  if (expression.includes(".click()") || expression.includes(".value=")) return { ok: true };
  return { ok: false, error: "unrecognized expression in fixture" };
}

function serveCdp(socket) {
  cdpConnections++;
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      let len = buffer[1] & 0x7f;
      let headerLen = 2;
      if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); headerLen = 4; }
      else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); headerLen = 10; }
      const maskLen = (buffer[1] & 0x80) ? 4 : 0;
      const total = headerLen + maskLen + len;
      if (buffer.length < total) return;
      const frame = buffer.subarray(0, total);
      buffer = buffer.subarray(total);
      const { opcode, payload } = decodeClientFrame(frame);
      if (opcode === 0x8) { socket.end(); return; }            // close
      if (opcode === 0x9) { socket.write(serverFrame(payload, 0xA)); continue; } // ping -> pong
      if (opcode !== 0x1) continue;                            // text only
      handleMessage(payload.toString("utf8"), socket);
    }
  });
}

function handleMessage(text, socket) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
  if (msg.method === "Target.attachToTarget") {
    // Real relay emits attachedToTarget then replies with the session id.
    socket.write(serverFrame(JSON.stringify({
      sessionId: SESSION_ID, method: "Target.attachedToTarget",
      params: { sessionId: SESSION_ID, targetInfo: { targetId: TARGET.id, type: "page" }, waitingForDebugger: false },
    })));
    socket.write(serverFrame(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result: { sessionId: SESSION_ID } })));
    return;
  }
  if (msg.method === "Runtime.evaluate" && msg.sessionId === SESSION_ID) {
    const expression = msg.params?.expression;
    if (typeof expression !== "string") {
      socket.write(serverFrame(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, error: { code: -32602, message: "missing expression" } })));
      return;
    }
    const value = evalValueFor(expression);
    const result = { result: { type: typeof value === "string" ? "string" : "object", value }, exceptionDetails: undefined };
    socket.write(serverFrame(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result })));
    return;
  }
  socket.write(serverFrame(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, error: { code: -32601, message: "method not found: " + msg.method } })));
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
  if (req.url === "/json/list" || req.url === "/json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([TARGET]));
    return;
  }
  res.writeHead(404); res.end();
});
server.on("upgrade", (req, socket) => {
  if (req.url !== "/cdp") { socket.destroy(); return; }
  if (req.headers.origin) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.end(); return; }
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  serveCdp(socket);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;

// ---- Direct CDP client against the real protocol shape ---------------------
const client = new RelayCdpClient(BASE);
const url = TARGET.url;

let out = await client.run(TARGET.id, url, { kind: "getText" });
assert.equal(out.ok, true);
assert.match(out.text, /APPLY button/);

out = await client.run(TARGET.id, url, { kind: "getUrl" });
assert.equal(out.ok, true);
assert.equal(out.text, url);

out = await client.run(TARGET.id, url, { kind: "getTitle" });
assert.equal(out.ok, true);
assert.equal(out.text, "Fixture Apply");

out = await client.run(TARGET.id, url, { kind: "click", selector: "#submit" });
assert.equal(out.ok, true);
out = await client.run(TARGET.id, url, { kind: "fill", selector: "#name", value: "Ada" });
assert.equal(out.ok, true);

// A selector the page does not have reports failure on the page, not a lie.
out = await client.run(TARGET.id, url, { kind: "click", selector: "#missing" });
assert.equal(out.ok, false);
assert.match(out.error, /selector not found/);

// Strict tab binding: the exact URL must still match; a changed URL fails closed.
await assert.rejects(() => client.run(TARGET.id, "https://other.example/moved", { kind: "getText" }),
  /URL changed/);
// A vanished target fails closed.
await assert.rejects(() => client.run("PAGEnone.1", url, { kind: "getText" }), /no longer open/);

// TOCTOU: discovery (/json/list) still reports the bound URL, but the tab
// navigated before Runtime.evaluate ran. The guarded expression re-checks the
// live location.href and must fail before the click reaches the page.
pageUrl = "https://evil.example/steal";
out = await client.run(TARGET.id, url, { kind: "click", selector: "#submit" });
assert.equal(out.ok, false);
assert.match(out.error, /page navigated since binding/);
// The click was not executed on the (navigated) page: the guard fired first.
assert.equal(out.text, "");
pageUrl = TARGET.url; // reset the simulated page for the remaining tests

// Off-host / privileged relay origins are rejected before any websocket opens,
// so an injectable mock targets transport can never reroute /cdp off-machine.
assert.throws(() => new RelayCdpClient("https://evil.example:9224"), /loopback/);
assert.throws(() => new RelayCdpClient("http://10.0.0.5:9224"), /loopback/);
assert.throws(() => new RelayCdpClient("http://127.0.0.1:9224?token=x"), /loopback/);

// Bounded websocket handshake: an endpoint that accepts TCP but never completes
// the upgrade fails closed instead of hanging the caller.
const stall = http.createServer((req, res) => {
  if (req.url === "/json/list") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify([TARGET])); return; }
  res.writeHead(404); res.end();
});
stall.on("upgrade", () => { /* deliberately never send the 101 handshake */ });
await new Promise((resolve) => stall.listen(0, "127.0.0.1", resolve));
const stallClient = new RelayCdpClient(`http://127.0.0.1:${stall.address().port}`, undefined, { handshakeTimeoutMs: 300 });
await assert.rejects(() => stallClient.run(TARGET.id, url, { kind: "getText" }), /timed out connecting/);
stall.close();

// Relay click/fill are sensitive (may submit a form) and never auto-approved;
// read-only observation is not sensitive. Pure checks, no operator dialog.
assert.equal(needsComputerApproval("agent_browser_click", "sensitive"), true);
assert.equal(needsComputerApproval("agent_browser_fill", "sensitive"), true);
assert.equal(needsComputerApproval("agent_browser_tab_list", "sensitive"), false);

// The fixture only ever received our fixed templates, never user-controlled code.
assert.ok(receivedExpressions.length > 0);
assert.ok(receivedExpressions.every((e) => !e.includes("process.exit") && !e.includes("fetch(") && !e.includes(";fetch")));
// 5 successful reads/actions + 1 missing-selector click + 1 TOCTOU click connect;
// the 2 strict-binding failures and the off-host/timeout cases never reach /cdp.
assert.equal(cdpConnections, 7);

// ---- Integrated computer_observe / computer_act routing --------------------
process.env.MCP_COMPUTER_APPROVAL_MODE = "off";
process.env.LCP_BROWSER_RELAY_URL = BASE;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-relay-cdp-"));
const prevPermissions = process.env.PERMISSIONS_CONFIG;
process.env.PERMISSIONS_CONFIG = path.join(root, "permissions.json");
savePermissionConfig({ profile: "open" });

const upstreamInvocations = [];
const manager = {
  getServerConfig(id) {
    return { id, enabled: true, transport: "stdio", expose: "meta_only" };
  },
  async listTools(id) {
    const provider = id.includes("desktop") ? "desktop" : "browser";
    return [...allowedComputerUseTools(provider, "observe"), ...allowedComputerUseTools(provider, "act")]
      .map((name) => ({ name }));
  },
  async callTool(id, tool, args) {
    upstreamInvocations.push({ id, tool, args });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  },
};

const mcpServer = new McpServer({ name: "relay-cdp-test", version: "1.0.0" });
registerComputerUseTools(mcpServer, manager);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const clientMcp = new Client({ name: "relay-cdp-test-client", version: "1.0.0" }, { capabilities: {} });
await mcpServer.connect(serverTransport);
await clientMcp.connect(clientTransport);
const call = (name, args) => clientMcp.callTool({ name, arguments: args });

async function callTool(name, args) {
  const res = await call(name, args);
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  return { ok: res.isError !== true && res.structuredContent?.ok !== false, text, parsed: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

try {
  // Discovery via agent_browser_connect returns the opaque target + exact url.
  const connect = await callTool("computer_act", {
    provider: "browser", tool: "agent_browser_connect",
    arguments: { target: "http://127.0.0.1:9224" }, allow_input: true,
  });
  assert.equal(connect.parsed.ok, true);
  assert.equal(connect.parsed.data.targets[0].targetId, TARGET.id);
  assert.equal(connect.parsed.data.targets[0].url, url);

  // Observe routes to the relay (getText), never to Vercel.
  const observe = await callTool("computer_observe", {
    provider: "browser", tool: "agent_browser_get_text", arguments: { target: TARGET.id, url },
  });
  assert.equal(observe.ok, true);
  assert.match(observe.parsed.data.output, /APPLY button/);

  // agent_browser_tab_list is read-only via computer_observe: no allow_input,
  // exposes only non-credential tab metadata, and lists the exact target id.
  const tabList = await callTool("computer_observe", {
    provider: "browser", tool: "agent_browser_tab_list", arguments: {},
  });
  assert.equal(tabList.ok, true);
  assert.equal(tabList.parsed.data.targets[0].targetId, TARGET.id);
  assert.equal(tabList.parsed.data.targets[0].url, url);

  // Act (click) routes to the relay and is not blindly replayed.
  const click = await callTool("computer_act", {
    provider: "browser", tool: "agent_browser_click", allow_input: true,
    arguments: { target: TARGET.id, url, selector: "#submit" },
  });
  assert.equal(click.ok, true);

  // Unsupported browser surface fails closed, never falls back to Vercel.
  const unsupported = await callTool("computer_act", {
    provider: "browser", tool: "agent_browser_open", allow_input: true, arguments: { url: "https://example.org/" },
  });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.text, /not supported/);

  // Stale URL binding fails closed even through the tool surface.
  const stale = await callTool("computer_observe", {
    provider: "browser", tool: "agent_browser_get_text", arguments: { target: TARGET.id, url: "https://other.example/moved" },
  });
  assert.equal(stale.ok, false);
  assert.match(stale.parsed.data.output, /URL changed/);

  // Failure with an explicit tab target when the relay is NOT configured must
  // fail closed and never fall back to Vercel/desktop.
  delete process.env.LCP_BROWSER_RELAY_URL;
  const noRelay = await call("computer_observe", {
    provider: "browser", tool: "agent_browser_get_text", arguments: { target: TARGET.id, url },
  });
  assert.equal(noRelay.isError, true);
  assert.match(JSON.stringify(noRelay), /not configured/);
  process.env.LCP_BROWSER_RELAY_URL = BASE;
  // The generic Vercel flow (no explicit target) is untouched: allowed and
  // not routed to the relay, proven by the unsupported/browser fail-closed tests.

  // Nothing ever reached the Vercel upstream: the relay is the only surface.
  assert.equal(upstreamInvocations.length, 0);
  console.log("OK integrated computer_observe/act route to OMP relay CDP, fail closed, no Vercel fallback");
} finally {
  delete process.env.LCP_BROWSER_RELAY_URL;
  delete process.env.MCP_COMPUTER_APPROVAL_MODE;
  process.env.PERMISSIONS_CONFIG = prevPermissions;
  await clientMcp.close();
  await mcpServer.close();
  server.close();
}

console.log("OK RelayCdpClient: real /cdp protocol (attach->session->Runtime.evaluate), strict URL binding, bounded eval");