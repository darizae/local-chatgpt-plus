import net from "node:net";
import { sameProjectRoot } from "./workspace-scope.js";
import { assertPathAllowed, canRunCommands } from "./permissions.js";

export interface DurableJob {
  id:string; label?:string; task_id?:string; session_id?:string;
  project_root:string|null; cwd:string; command:string; pid?:number;
  started_at:string; finished_at?:string; last_activity_at:string;
  running:boolean; stdin_writable:boolean; exit_code:number|null; signal:string|null;
  status:"running"|"completed"|"failed"|"stopped"|"interrupted";
  durable:true; reused?:boolean; liveness:string;
  stdout?:string; stderr?:string; truncated?:boolean;
}
export const durableJobsEnabled = () => Boolean(process.env.LCP_DURABLE_JOBS_SOCKET);
export const isDurableJobId = (id?:string) => Boolean(id && /^dur-[a-f0-9]{32}$/.test(id));
export async function durableRpc<T>(req:Record<string,unknown>):Promise<T> {
  const socketPath=process.env.LCP_DURABLE_JOBS_SOCKET;
  if(!socketPath) throw new Error("Durable job supervisor is not configured");
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(socketPath);
    let bytes=0; const chunks:Buffer[]=[];
    const fail=(e:Error)=>{socket.destroy();reject(e);};
    socket.setTimeout(12000,()=>fail(new Error("Durable job supervisor timed out; inspect status before retrying")));
    socket.on("error",()=>fail(new Error("Durable job supervisor unavailable; no local fallback was launched")));
    socket.on("connect",()=>socket.write(JSON.stringify(req)+"\n"));
    socket.on("data",(b:Buffer)=>{
      bytes+=b.length;
      if(bytes>8_000_000){fail(new Error("Durable job reply too large"));return;}
      chunks.push(b);
      if(b.includes(10)){
        try{
          const parsed=JSON.parse(Buffer.concat(chunks).toString("utf8"));
          socket.destroy();
          if(!parsed.ok) reject(new Error(parsed.error||"Durable job request failed"));
          else resolve(parsed.data as T);
        }catch{fail(new Error("Invalid durable job response"));}
      }
    });
    socket.on("end",()=>fail(new Error("Incomplete durable job response")));
  });
}
export function assertDurableScope(job:DurableJob,scope:{scoped:boolean;projectRoot:string|null},control=false){
  if((control&&!scope.scoped)||(scope.scoped&&!sameProjectRoot(job.project_root,scope.projectRoot)))
    throw new Error("Durable job is outside the requested workspace scope");
  assertPathAllowed(job.cwd);
  if(control&&!canRunCommands()) throw new Error("Command execution is disabled");
}
export async function waitDurable(id:string, mode:"none"|"exit"|"text", seconds:number, needle?:string){
  const start=Date.now();
  const deadline=start+seconds*1000;
  while(true){
    const job=await durableRpc<DurableJob>({action:mode==="text"?"output":"status",id,tail_chars:200000});
    const met=mode==="none"||(mode==="exit"&&!job.running)||(mode==="text"&&Boolean(needle&&((job.stdout||"").includes(needle)||(job.stderr||"").includes(needle))));
    if(met||!job.running||Date.now()>=deadline) return {condition_met:met,timed_out:!met&&job.running,waited_ms:Date.now()-start};
    await new Promise(r=>setTimeout(r,Math.min(500,Math.max(0,deadline-Date.now()))));
  }
}
