import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {spawn,execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
const exec=promisify(execFile);
const script=fileURLToPath(import.meta.url);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
if(process.argv[2]==="client"){
  const [root,method,raw]=process.argv.slice(3);
  const {Client}=await import("@modelcontextprotocol/sdk/client/index.js");
  const {InMemoryTransport}=await import("@modelcontextprotocol/sdk/inMemory.js");
  const {createMcpServer}=await import("../dist/server-factory.js");
  const [ct,st]=InMemoryTransport.createLinkedPair();
  const server=createMcpServer(root,20,[root],true);
  const client=new Client({name:"durable-fixture",version:"1"},{capabilities:{}});
  try{
    await server.connect(st); await client.connect(ct);
    const result=await client.callTool({name:method,arguments:JSON.parse(raw)});
    console.log("DURABLE_RESULT "+JSON.stringify(result.structuredContent||result));
  }finally{await client.close();await server.close();}
  process.exit(0);
}
if(process.platform!=="linux"||process.getuid?.()===0){
  console.log("SKIP durable service integration requires non-root Linux");
  process.exit(0);
}
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),"ldj-"));
const root=path.join(tmp,"projects"), repo=path.join(root,"one"), other=path.join(root,"two");
const sock=path.join(tmp,"jobs.sock"), state=path.join(tmp,"state");
let daemon;
const env={...process.env,LCP_DURABLE_JOBS_SOCKET:sock,PERMISSIONS_CONFIG:path.join(tmp,"permissions.json"),
  MCP_OPERATION_STATE_DIR:path.join(tmp,"operations"),MCP_AGENT_TASK_STATE_DIR:path.join(tmp,"tasks"),
  LOCAL_HOOKS_CONFIG:path.join(tmp,"hooks.json")};
async function launch(){
  daemon=spawn("/usr/bin/python3",["-I",fileURLToPath(new URL("./vps/lcp-durable-jobs",import.meta.url)),"--root",root,"--state",state,"--socket",sock],{stdio:"ignore",env});
  for(let i=0;i<100;i++){
    try{await fs.stat(sock);return;}catch{}
    if(daemon.exitCode!==null)throw Error("supervisor exited");
    await sleep(30);
  }
  throw Error("supervisor did not become ready");
}
async function call(method,args){
  const {stdout}=await exec(process.execPath,[script,"client",root,method,JSON.stringify(args)],{env,timeout:15000,maxBuffer:2_000_000});
  const line=stdout.split("\n").find(x=>x.startsWith("DURABLE_RESULT "));
  assert.ok(line,stdout);
  const result=JSON.parse(line.slice(15));
  return result;
}
async function good(method,args){
  const r=await call(method,args);assert.equal(r.ok,true,JSON.stringify(r));return r.data;
}
try{
  await fs.mkdir(repo,{recursive:true});await fs.mkdir(other,{recursive:true});
  for(const dir of [repo,other]) await exec("/usr/bin/git",["-C",dir,"init","-q"]);
  await fs.writeFile(env.PERMISSIONS_CONFIG,JSON.stringify({version:1,profile:"custom",path_roots:[root],allow_write:true,allow_commands:true}));
  await launch();
  const args={command:"printf 'READY\\n'; read -r word; printf 'GOT:%s\\n' \"$word\"; exit 7",working_directory:repo,label:"durable-fixture"};
  const task=await good("agent_task",{action:"start",title:"Durable task fixture",objective:"verify restart recovery",workspace:repo,plan:["Run fixture"]});
  args.task_id=task.task.id;
  const started=await good("start_process",args);
  const id=started.id;assert.match(id,/^dur-/);assert.equal(started.durable,true);
  // Each good() launches a new MCP server process and then exits.
  const reused=await good("start_process",args);assert.equal(reused.id,id);assert.equal(reused.reused,true);
  const ready=await good("process_output",{id,workspace:repo,wait_for:"text",wait_text:"READY",wait_seconds:3});
  assert.equal(ready.wait.condition_met,true);assert.equal(ready.running,true);
  const linked=await good("agent_task",{action:"get",id:args.task_id,workspace:repo});
  assert.equal(linked.task.execution.state,"running");
  assert.ok(linked.task.execution.running_worker_ids.includes(id));
  const wrong=await call("process_output",{id,workspace:other});assert.notEqual(wrong.ok,true);
  await good("process_input",{id,workspace:repo,input:"cross-restart",close_stdin:true});
  const complete=await good("process_output",{id,workspace:repo,wait_for:"exit",wait_seconds:4});
  assert.equal(complete.running,false);assert.equal(complete.exit_code,7);assert.match(complete.stdout,/GOT:cross-restart/);
  const history=await good("process_history",{id,workspace:repo});assert.equal(history.operation.effective_status,"failed");
  assert.equal(history.operation.command,"[command withheld]");
  const status=await good("process_status",{workspace:repo});assert.ok(status.processes.some(p=>p.id===id));
  const second=await good("start_process",{command:"sleep 60",working_directory:repo});
  const stopped=await good("stop_process",{id:second.id,workspace:repo,force:true});
  assert.equal(stopped.running,false);assert.equal(stopped.status,"stopped");
  // A supervisor crash is not an MCP restart. A synthetic unfinished receipt
  // is marked interrupted on supervisor restart, never automatically rerun.
  const fake="dur-"+"a".repeat(32);
  await fs.mkdir(path.join(state,fake));
  await fs.writeFile(path.join(state,fake,"state.json"),JSON.stringify({id:fake,running:true,started_at:new Date().toISOString(),project_root:repo,cwd:repo,command:"[command withheld]"}));
  daemon.kill("SIGTERM");await new Promise(r=>daemon.once("exit",r));daemon=undefined;
  await fs.unlink(sock).catch(()=>{});
  await launch();
  const interrupted=await good("process_history",{id:fake,workspace:repo});
  assert.equal(interrupted.operation.effective_status,"interrupted");
  const after=await good("process_output",{id,workspace:repo});assert.match(after.stdout,/GOT:cross-restart/);
  console.log("Durable jobs: distinct MCP processes, dedupe, scope, stdin, exit/log/history, cancellation and interrupted supervisor recovery passed");
}finally{
  if(daemon&&daemon.exitCode===null){daemon.kill("SIGTERM");await new Promise(r=>daemon.once("exit",r));}
  await fs.rm(tmp,{recursive:true,force:true});
}
