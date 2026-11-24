import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const temp=await fs.mkdtemp(path.join(os.tmpdir(),"lcp-dev-cap-"));
process.env.PERMISSIONS_CONFIG=path.join(temp,"permissions.json");
const perms=await import("../dist/lib/permissions.js");
const {DevelopmentRepl}=await import("../dist/lib/development-repl.js");
const {developmentChildEnvironment}=await import("../dist/lib/development-env.js");
const repl=new DevelopmentRepl(temp);
try {
  perms.savePermissionConfig({profile:"custom",path_roots:[temp],allow_commands:true,allow_write:true,
    allow_workspace_pty:true,allow_workspace_repl:true,allow_configured_upstream_tools:true,allow_unsafe_runtimes:false});
  for(const kind of ["pty","repl","upstream"]) perms.requireDevelopmentCapability(kind,temp);
  assert.throws(()=>perms.requireDevelopmentCapability("pty",path.dirname(temp)),/outside configured roots/);
  assert.throws(()=>perms.requireUnsafeRuntimeAllowed("unrestricted"),/unrestricted runtime/);
  assert.deepEqual(developmentChildEnvironment({PATH:"/bin",MCP_TOKEN:"private",API_KEY:"private",npm_config_cache:"/cache"}),{PATH:"/bin",npm_config_cache:"/cache"});
  process.env.LCP_TEST_PRIVATE_SECRET="canary";
  assert.equal((await repl.evaluate("globalThis.x=41; return process.env.LCP_TEST_PRIVATE_SECRET",1000)).value,undefined);
  assert.equal((await repl.evaluate("return ++globalThis.x",1000)).value,"42");
  await assert.rejects(repl.evaluate("await new Promise(()=>{})",100),/timed out/);
  assert.equal((await repl.evaluate("return typeof globalThis.x",1000)).value,"'undefined'");
  perms.savePermissionConfig({profile:"custom",path_roots:[temp],allow_commands:true,allow_write:true});
  assert.throws(()=>perms.requireDevelopmentCapability("pty",temp),/unrestricted runtime/);
  console.log("Workspace PTY/REPL/upstream opt-in, minimized child env, REPL state and timeout tests passed");
} finally {
  repl.reset();
  await fs.rm(temp,{recursive:true,force:true});
}
