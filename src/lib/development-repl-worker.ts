import { createRequire } from "node:module";
import path from "node:path";
import util from "node:util";
import vm from "node:vm";

// This process is deliberately separate from the MCP server. It inherits the
// service OS sandbox and a minimized environment, not the server's process.
let output: string[] = [];
let chars = 0;
const append = (text: string) => {
  if (chars >= 50000) return;
  const part = text.slice(0, 50000 - chars);
  output.push(part);
  chars += part.length;
};
const context = vm.createContext({
  Buffer, process, setTimeout, clearTimeout, fetch,
  require: createRequire(path.join(process.cwd(), "package.json")),
  console: { log: (...args: unknown[]) => append(args.map(v => util.inspect(v, {depth:4, maxStringLength:10000})).join(" ")) },
  nodeRepl: { write: (value: unknown) => append(String(value)) },
});
process.on("disconnect", () => process.exit(0));
process.on("message", async (raw: unknown) => {
  const req = raw as {id:string, code:string, timeout:number};
  output = [];
  chars = 0;
  try {
    const value = await vm.runInContext(`(async () => { ${req.code}\n})()`, context, {timeout:req.timeout});
    process.send?.({id:req.id, output:output.join("\n"), value:value===undefined?undefined:util.inspect(value,{depth:5,maxArrayLength:100,maxStringLength:10000}).slice(0,50000)});
  } catch (e) {
    process.send?.({id:req.id,error:e instanceof Error?e.message.slice(0,2000):String(e).slice(0,2000)});
  }
});
