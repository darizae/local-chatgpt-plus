/** Hermetic DNS-rebinding, Host, and Origin checks on the real Admin middleware. */
import assert from "node:assert/strict";
import express from "express";
import { localhostOnly } from "../dist/admin/localhost-guard.js";

const app = express();
app.use(express.json());
app.use(localhostOnly);
app.get("/health", (_req, res) => res.json({ ok: true }));
app.put("/change", (_req, res) => res.json({ changed: true }));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}`;
const check = async (name, headers, method, expected) => {
  const response = await fetch(url + (method === "PUT" ? "/change" : "/health"), {
    method, headers: { ...(method === "PUT" ? { "content-type": "application/json" } : {}), ...headers },
    ...(method === "PUT" ? { body: "{}" } : {}),
  });
  assert.equal(response.status, expected, name);
};
try {
  await check("loopback read", {}, "GET", 200);
  await check("same-origin write", { origin: url }, "PUT", 200);
  await check("cross-origin write", { origin: "https://evil.example" }, "PUT", 403);
  await check("cross-origin read", { origin: "https://evil.example" }, "GET", 403);
  await check("null origin", { origin: "null" }, "PUT", 403);
  await check("wrong local port origin", { origin: "http://127.0.0.1:1234" }, "PUT", 403);
  await check("wrong localhost identity", { origin: `http://localhost:${port}` }, "PUT", 403);
  await check("cross-site fetch metadata", { "sec-fetch-site": "cross-site" }, "PUT", 403);
  // Node fetch normalizes Host; use raw Node HTTP to exercise the actual header.
  const { request } = await import("node:http");
  const checkHost = async (host, expected) => {
    const status = await new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path: "/health", headers: { Host: host } },
        (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, expected, host);
  };
  await checkHost(`attacker.example:${port}`, 403);
  await checkHost("127.0.0.1:9", 403);
  console.log("OK Admin origin/host regression: 10 cases");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
