import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function run(extra) {
  const child = spawn(process.execPath, [path.join(root,"dist/index.js")], {
    cwd: root,
    env: {
      ...process.env,
      INBOUND_AUTH_MODE: "token",
      MCP_TOKEN: "",
      HOST: "127.0.0.1",
      LOCAL_CODER_ADMIN_ENABLED: "false",
      LOCAL_CODER_MANAGE_TUNNEL: "0",
      NODE_ENV: "production",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output="";
  child.stdout.on("data", data => { output+=data.toString(); });
  child.stderr.on("data", data => { output+=data.toString(); });
  const code=await Promise.race([
    new Promise(resolve=>child.on("close",resolve)),
    new Promise((_,reject)=>setTimeout(()=>{child.kill("SIGTERM");reject(new Error("fixture did not reject unsafe start"));},15000)),
  ]);
  return {code,output};
}
const missing=await run({});
assert.notEqual(missing.code,0);
assert.match(missing.output,/Token mode requires MCP_TOKEN/);
const outside=await run({NODE_ENV:"test",LCP_ALLOW_UNAUTHENTICATED_TEST_ONLY:"1",HOST:"0.0.0.0"});
assert.notEqual(outside.code,0);
assert.match(outside.output,/Token mode requires MCP_TOKEN/);
console.log("OK empty-token MCP startup rejects production and non-loopback test override");
