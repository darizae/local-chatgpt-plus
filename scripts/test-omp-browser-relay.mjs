import assert from "node:assert/strict";
import http from "node:http";
import { CODEX_AGENT_PROMPT } from "../dist/lib/codex-agent-prompt.js";
import {
  BrowserRelayClient,
  HttpRelayTargetsTransport,
  MockRelayTargetsTransport,
  matchTab,
  normalizeTabUrl,
  routeBrowserRequest,
} from "../dist/lib/omp-browser-relay.js";

assert.match(CODEX_AGENT_PROMPT, /already-open Brave tab/);
assert.match(CODEX_AGENT_PROMPT, /Do not route a browser action through a shell or generic subagent/);
console.log("OK agent prompt blocks Vercel/desktop takeover of an identified Brave tab");

// ---- Pure target matching: conservative, fail-closed, no implicit pick ----
const openTargets = [
  { targetId: "PAGEt.1", url: "https://univers.breezy.hr/p/efa58c39933301-forward-deployed-engineer/apply", title: "Apply", active: false },
  { targetId: "PAGEt.2", url: "https://univers.breezy.hr/p/other/apply", title: "Other", active: true },
  { targetId: "PAGEt.3", url: "https://example.org/", title: "Example", active: false },
];

assert.equal(normalizeTabUrl("https://example.org/"), "https://example.org/");
assert.equal(normalizeTabUrl("https://example.org/a?x=1#frag"), "https://example.org/a?x=1#frag");

let m = matchTab(openTargets, { kind: "byUrl", url: "https://univers.breezy.hr/p/efa58c39933301-forward-deployed-engineer/apply" });
assert.equal(m.status, "matched");
assert.equal(m.target.targetId, "PAGEt.1");
// Query parameters and hash routes may select different pages or form states.
m = matchTab(openTargets, { kind: "byUrl", url: openTargets[0].url + "?q=1" });
assert.equal(m.status, "missing");
m = matchTab(openTargets, { kind: "byUrl", url: openTargets[0].url + "#another-form" });
assert.equal(m.status, "missing");
m = matchTab(openTargets, { kind: "byUrl", url: "https://missing.example/x" });
assert.equal(m.status, "missing");
m = matchTab(openTargets, { kind: "byTargetId", targetId: "PAGEt.2" });
assert.equal(m.status, "matched");
assert.equal(m.target.targetId, "PAGEt.2");
m = matchTab(openTargets, { kind: "byTargetId", targetId: "PAGEt.99" });
assert.equal(m.status, "missing");
// Duplicate normalized URLs must be ambiguous, never resolved implicitly.
const dupTargets = [...openTargets, { ...openTargets[0], targetId: "PAGEt.7", title: "Dup" }];
m = matchTab(dupTargets, { kind: "byUrl", url: openTargets[0].url });
assert.equal(m.status, "ambiguous");
assert.equal(m.matches.length, 2);
console.log("OK matchTab: exact canonical URL including query/hash, target-id, missing, ambiguous (fail closed)");

// ---- Routing: OMP relay preferred only when configured + explicit target ----
let route = routeBrowserRequest({ relayConfigured: false, relayTargets: openTargets, request: { kind: "byUrl", url: openTargets[0].url } });
assert.equal(route.adapter, "none"); // no relay configured -> default path
route = routeBrowserRequest({ relayConfigured: true, relayTargets: openTargets, request: { kind: "byUrl", url: openTargets[0].url } });
assert.equal(route.adapter, "omp-relay");
assert.equal(route.target.targetId, "PAGEt.1");
route = routeBrowserRequest({ relayConfigured: true, relayTargets: openTargets, request: { kind: "byUrl", url: "https://missing.example" } });
assert.equal(route.adapter, "none"); // fail closed, never Vercel
assert.match(route.reason, /no already-open tab/);
route = routeBrowserRequest({ relayConfigured: true, relayTargets: dupTargets, request: { kind: "byUrl", url: openTargets[0].url } });
assert.equal(route.adapter, "none"); // ambiguous -> fail closed
assert.match(route.reason, /specify the exact target/);
route = routeBrowserRequest({ relayConfigured: true, relayTargets: openTargets, request: null });
assert.equal(route.adapter, "none"); // no explicit already-open tab -> not relay's silent default
console.log("OK routeBrowserRequest: no silent Vercel/desktop fallback; fail closed on missing/ambiguous/no-target");

// ---- Mock transport: read-only listing against real target shape ----
const mock = new MockRelayTargetsTransport([...openTargets]);
const client = new BrowserRelayClient("http://127.0.0.1:1", mock);
assert.deepEqual(await client.listTargets(), openTargets);
mock.setTargets([]);
assert.deepEqual(await client.listTargets(), []);
console.log("OK MockRelayTargetsTransport + BrowserRelayClient read-only target listing");

// ---- Real HTTP transport against an offline fixture serving the REAL
//      /json/list shape (opaque PAGE ids) ----
const TOKEN = "test-relay-token-000";
const port = 19000 + Math.floor(Math.random() * 500);
const fixtureTargets = [
  { id: "PAGEabc.42", type: "page", title: "Apply", url: "https://univers.breezy.hr/p/abc/apply", active: "true", discarded: "false" },
  { id: "PAGExyz.9", type: "page", title: "Example", url: "https://example.org/", active: "false", discarded: "false" },
];
const fixture = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.searchParams.get("token") === "GONE") { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "relay extension is not connected" })); return; }
  if (url.searchParams.get("token") !== TOKEN) { res.writeHead(401); res.end("unauthorized"); return; }
  if (url.pathname === "/json/list") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(fixtureTargets)); return; }
  res.writeHead(404); res.end("not found");
});
await new Promise((r) => fixture.listen(port, "127.0.0.1", r));
try {
  assert.throws(() => new HttpRelayTargetsTransport("https://example.org:9224", TOKEN), /loopback HTTP origin/);
  assert.throws(() => new HttpRelayTargetsTransport("http://192.0.2.1:9224", TOKEN), /loopback HTTP origin/);
  assert.throws(() => new HttpRelayTargetsTransport("http://127.0.0.1", TOKEN), /loopback HTTP origin/);
  assert.throws(() => new HttpRelayTargetsTransport("http://user:pass@127.0.0.1:9224", TOKEN), /loopback HTTP origin/);
  const transport = new HttpRelayTargetsTransport(`http://127.0.0.1:${port}`, TOKEN);
  const realClient = new BrowserRelayClient(`http://127.0.0.1:${port}`, transport);
  const targets = await realClient.listTargets();
  assert.equal(targets.length, 2);
  assert.equal(targets[0].targetId, "PAGEabc.42");
  assert.equal(targets[0].active, true);
  assert.equal(targets[1].url, "https://example.org/");
  // Token required.
  await assert.rejects(new HttpRelayTargetsTransport(`http://127.0.0.1:${port}`).listTargets(), /HTTP 401/);
  // Extension-not-connected (503) is a distinct, non-silent failure.
  await assert.rejects(new HttpRelayTargetsTransport(`http://127.0.0.1:${port}`, "GONE").listTargets(), /no extension is connected/);
} finally {
  fixture.close();
}
console.log("OK HttpRelayTargetsTransport: real /json/list shape, token auth, 503 extension-gone handling");

console.log("OK OMP Browser Relay: real v19 target listing + explicit fail-closed binding (live /cdp driving remains blocked)");