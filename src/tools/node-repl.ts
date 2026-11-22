import { createRequire } from "node:module";
import path from "node:path";
import util from "node:util";
import vm from "node:vm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { requireUnsafeRuntimeAllowed } from "../lib/permissions.js";

interface ReplState {
  context: vm.Context;
}

const states = new WeakMap<McpServer, ReplState>();

function createState(workspaceRoot: string): ReplState {
  const output: string[] = [];
  const sandbox: Record<string, unknown> = {
    Buffer,
    process,
    setTimeout,
    clearTimeout,
    fetch,
    require: createRequire(path.join(workspaceRoot, "package.json")),
    console: { log: (...values: unknown[]) => output.push(values.map((value) => util.inspect(value, { depth: 4 })).join(" ")) },
    nodeRepl: { write: (value: unknown) => output.push(String(value)) },
    __localCoderOutput: output,
  };
  return { context: vm.createContext(sandbox) };
}

export function registerNodeReplTool(server: McpServer, workspaceRoot: string): void {
  server.registerTool(
    "node_repl",
    {
      title: "Node REPL",
      description: "Stateful JavaScript session. Store state on globalThis; nodeRepl.write() emits text.",
      inputSchema: {
        action: z.enum(["eval", "reset", "status"]).default("eval"),
        code: z.string().optional().describe("JavaScript. Use globalThis for state across calls; nodeRepl.write() emits text."),
        timeout_ms: z.number().int().min(100).max(60000).optional().default(30000),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ action, code, timeout_ms }) => {
      if (action === "reset") {
        states.delete(server);
        return toolResult("node_repl", { reset: true });
      }
      let state = states.get(server);
      if (!state) {
        state = createState(workspaceRoot);
        states.set(server, state);
      }
      if (action === "status") {
        return toolResult("node_repl", { persistent: true, computer_use_available: false, computer_use_error: "Use the separate browser MCP integration for computer control." });
      }
      if (!code?.trim()) throw new Error("code is required for node_repl eval");
      requireUnsafeRuntimeAllowed("node_repl");
      const output = state.context.__localCoderOutput as string[];
      output.length = 0;
      const value = await vm.runInContext(`(async () => { ${code}\n})()`, state.context, { timeout: timeout_ms }) as Promise<unknown>;
      return toolResult("node_repl", {
        output: output.join("\n"),
        value: value === undefined ? undefined : util.inspect(value, { depth: 5, maxArrayLength: 100 }),
        computer_use_available: false,
      });
    }
  );
}