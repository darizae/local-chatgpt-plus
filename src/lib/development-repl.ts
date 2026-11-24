import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { developmentChildEnvironment } from "./development-env.js";

export class DevelopmentRepl {
  private child?: ChildProcess;
  private busy = false;
  constructor(readonly cwd: string) {}
  reset(): void {
    this.child?.kill("SIGKILL");
    this.child = undefined;
  }
  async evaluate(code: string, timeout: number): Promise<{output:string,value?:string}> {
    if (this.busy) throw new Error("REPL evaluation already running");
    this.busy = true;
    try {
      if (!this.child?.connected) {
        this.child = fork(fileURLToPath(new URL("./development-repl-worker.js", import.meta.url)), [], {
          cwd: this.cwd, env: developmentChildEnvironment(process.env), execArgv: [],
          stdio:["ignore","ignore","ignore","ipc"], windowsHide:true,
        });
      }
      const child = this.child;
      const id = randomUUID();
      return await new Promise((resolve,reject) => {
        let settled = false;
        const finish = (error?: Error, value?: {output:string,value?:string}) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.off("message", onMessage);
          child.off("exit", onExit);
          child.off("error", onError);
          if (error) reject(error);
          else resolve(value!);
        };
        const onMessage = (raw: unknown) => {
          const r=raw as {id?:string,error?:string,output?:string,value?:string};
          if (r?.id!==id) return;
          if (typeof r.error==="string") finish(new Error(r.error));
          else finish(undefined,{output:typeof r.output==="string"?r.output.slice(0,50000):"",value:typeof r.value==="string"?r.value.slice(0,50000):undefined});
        };
        const onExit = () => finish(new Error("Workspace REPL exited; state reset"));
        const onError = (error: Error) => finish(error);
        const timer = setTimeout(() => {
          this.reset();
          finish(new Error("Workspace REPL timed out; state reset"));
        }, timeout + 500);
        child.on("message",onMessage);
        child.once("exit",onExit);
        child.once("error",onError);
        child.send({id,code,timeout},error=>{if(error) finish(error);});
      });
    } finally { this.busy=false; }
  }
}
