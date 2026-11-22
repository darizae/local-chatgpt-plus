import { spawn } from "node:child_process";

export type ApprovalProvider = "desktop" | "browser";
export type ApprovalMode = "off" | "sensitive" | "all";

const SENSITIVE = new Set([
  "desktop_type", "desktop_set_value", "desktop_clear", "desktop_focus_window",
  "agent_browser_connect", "agent_browser_open", "agent_browser_tab_new",
  "agent_browser_click", // a click may submit a sensitive form; require approval
  "agent_browser_fill", "agent_browser_type", "agent_browser_press",
  "agent_browser_select", "agent_browser_check", "agent_browser_uncheck",
]);
const WAITS = new Set([
  "desktop_wait", "agent_browser_wait_ms", "agent_browser_wait_for_selector",
  "agent_browser_wait_for_text", "agent_browser_wait_for_load",
]);
const leaseMs = 90_000;
const leases = new Map<string, number>();
const pending = new Map<string, Promise<boolean>>();

export function approvalMode(): ApprovalMode {
  const mode = (process.env.MCP_COMPUTER_APPROVAL_MODE ?? "sensitive").trim().toLowerCase();
  if (mode !== "off" && mode !== "sensitive" && mode !== "all") {
    throw new Error("MCP_COMPUTER_APPROVAL_MODE must be off, sensitive, or all");
  }
  return mode;
}

export function needsComputerApproval(tool: string, mode = approvalMode()): boolean {
  return mode !== "off" && !WAITS.has(tool) && (mode === "all" || SENSITIVE.has(tool));
}

/**
 * Independent, local, interactive operator confirmation. AppleScript dialogs
 * are unavailable in headless sessions; failures deny access rather than
 * silently authorizing computer input.
 */
async function macOperatorPrompt(provider: string, tool: string, scope: string): Promise<boolean> {
  if (process.platform !== "darwin") throw new Error("Local computer approval requires an interactive macOS session");
  const body = `Local ChatGPT Plus requests computer control. Provider: ${provider}. Action: ${tool}. Scope: ${scope.slice(0, 160)}. Allow access to this scope for up to 90 seconds?`;
  // Always escape untrusted text before inserting it into an AppleScript string.
  const escaped = body.replace(/[\r\n\t]/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `set answer to display dialog "${escaped}" buttons {"Deny", "Allow"} default button "Deny" with title "Local ChatGPT Plus operator approval" giving up after 30
if gave up of answer then return "DENIED"
if button returned of answer is "Allow" then return "APPROVED"
return "DENIED"`;
  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let settled = false;
    const finish = (allowed: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(allowed);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false, new Error("Operator confirmation timed out"));
    }, 32_000);
    timeout.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(0, 512); });
    child.on("error", (error) => finish(false, error));
    child.on("close", (code) => finish(code === 0 && stdout.trim() === "APPROVED"));
  });
}

export async function requireComputerApproval(
  provider: ApprovalProvider, tool: string, scope: string,
  confirm: (provider: string, tool: string, scope: string) => Promise<boolean> = macOperatorPrompt,
): Promise<void> {
  if (!needsComputerApproval(tool)) return;
  if (!scope || scope.length > 400) throw new Error("Computer approval requires a bounded scope");
  const key = provider + ":" + scope;
  const now = Date.now();
  for (const [name, expiry] of leases) if (expiry <= now) leases.delete(name);
  if ((leases.get(key) ?? 0) > now) return;
  let request = pending.get(key);
  if (!request) {
    request = confirm(provider, tool, scope);
    pending.set(key, request);
  }
  let allowed: boolean;
  try { allowed = await request; }
  finally { if (pending.get(key) === request) pending.delete(key); }
  if (!allowed) throw new Error("Computer input denied by the local operator");
  leases.set(key, Date.now() + leaseMs);
}