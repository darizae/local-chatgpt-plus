import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteTextSync } from "./atomic-file.js";

export type PermissionProfile = "open" | "workspace" | "read_only" | "custom";

export interface PermissionConfig {
  version: 1;
  profile: PermissionProfile;
  path_roots?: string[];
  allow_write?: boolean;
  allow_commands?: boolean;
  allow_unsafe_runtimes?: boolean;
  /** Narrow exception for one root-owned, non-writable bounded agent broker. */
  trusted_subagent_executable?: string;
  command_allow_patterns?: string[];
  command_deny_patterns?: string[];
}

const DEFAULT_CONFIG: PermissionConfig = { version: 1, profile: "workspace" };
const DEFAULT_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../profiles/permissions.json"
);
let runtimeWorkspaceRoots: string[] = [process.cwd()];

function configPath(): string {
  return path.resolve(process.env.PERMISSIONS_CONFIG || DEFAULT_CONFIG_PATH);
}

function normalizedRoot(value: string): string {
  return path.resolve(value);
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function normalizeConfig(raw: Partial<PermissionConfig> | undefined): PermissionConfig {
  if (raw?.version !== undefined && raw.version !== 1) {
    throw new Error(`Unsupported permission config version: ${String(raw.version)}`);
  }
  const validProfiles: PermissionProfile[] = ["open", "workspace", "read_only", "custom"];
  if (raw?.profile !== undefined && !validProfiles.includes(raw.profile as PermissionProfile)) {
    throw new Error(`Invalid permission profile: ${String(raw.profile)}`);
  }
  const profile: PermissionProfile = (raw?.profile as PermissionProfile | undefined) ?? "workspace";
  const pathRoots = optionalStringArray(raw?.path_roots, "path_roots");
  const allowPatterns = optionalStringArray(raw?.command_allow_patterns, "command_allow_patterns");
  const denyPatterns = optionalStringArray(raw?.command_deny_patterns, "command_deny_patterns");
  const trustedSubagent = raw?.trusted_subagent_executable;
  if (trustedSubagent !== undefined && (
    typeof trustedSubagent !== "string" || !path.isAbsolute(trustedSubagent) ||
    path.normalize(trustedSubagent) !== trustedSubagent || path.basename(trustedSubagent) !== "lcp-native-subagent"
  )) {
    throw new Error("trusted_subagent_executable must be an absolute path to lcp-native-subagent");
  }
  for (const [field, patterns] of [["command_allow_patterns", allowPatterns], ["command_deny_patterns", denyPatterns]] as const) {
    for (const pattern of patterns ?? []) {
      try {
        new RegExp(pattern, "i");
      } catch (error) {
        throw new Error(`${field} contains invalid regex '${pattern}': ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return {
    version: 1,
    profile,
    path_roots: pathRoots ? [...new Set(pathRoots.map(normalizedRoot))] : undefined,
    allow_write: optionalBoolean(raw?.allow_write, "allow_write"),
    allow_commands: optionalBoolean(raw?.allow_commands, "allow_commands"),
    allow_unsafe_runtimes: optionalBoolean(raw?.allow_unsafe_runtimes, "allow_unsafe_runtimes"),
    trusted_subagent_executable: trustedSubagent,
    command_allow_patterns: allowPatterns,
    command_deny_patterns: denyPatterns,
  };
}

export function setPermissionWorkspaceRoots(roots: string[]): void {
  const next = [...new Set(roots.filter(Boolean).map(normalizedRoot))];
  runtimeWorkspaceRoots = next.length ? next : [process.cwd()];
}

export function getPermissionConfig(): PermissionConfig {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(configPath(), "utf-8")) as Partial<PermissionConfig>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (process.env.PERMISSIONS_CONFIG) {
        // Explicitly selected config missing: fail closed rather than silently
        // becoming the unrestricted default profile.
        throw new Error(
          `Permission config not found at explicitly configured PERMISSIONS_CONFIG path '${configPath()}'; refusing to fall back to an unrestricted profile. Create the file or unset PERMISSIONS_CONFIG.`
        );
      }
      // Fresh checkout with no explicit config: use the safer workspace profile.
      return { ...DEFAULT_CONFIG };
    }
    throw new Error(
      `Failed to load permission config ${configPath()}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function savePermissionConfig(next: Partial<PermissionConfig>): PermissionConfig {
  const normalized = normalizeConfig(next);
  atomicWriteTextSync(configPath(), JSON.stringify(normalized, null, 2) + "\n");
  return normalized;
}

export function getPermissionConfigPath(): string {
  return configPath();
}

export function getPermissionProfile(): PermissionProfile {
  return getPermissionConfig().profile;
}

export function getEffectivePathRoots(): string[] {
  const config = getPermissionConfig();
  if (config.profile === "open") return [];
  const configured = config.path_roots?.length ? config.path_roots : runtimeWorkspaceRoots;
  return [...new Set(configured.map(normalizedRoot))];
}

function pathWithinRoot(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  if (!relative) return true;
  return !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export function isPathAllowed(targetPath: string): boolean {
  const config = getPermissionConfig();
  if (config.profile === "open") return true;
  const target = path.resolve(targetPath);
  return getEffectivePathRoots().some((root) => pathWithinRoot(target, root));
}

export function assertPathAllowed(targetPath: string): void {
  if (isPathAllowed(targetPath)) return;
  const roots = getEffectivePathRoots();
  throw new Error(
    `Permission denied by '${getPermissionProfile()}' profile: path is outside configured roots (${roots.join(", ") || "none"}): ${path.resolve(targetPath)}`
  );
}

export function canWriteFiles(): boolean {
  const config = getPermissionConfig();
  if (config.profile === "open" || config.profile === "workspace") return true;
  if (config.profile === "read_only") return false;
  return config.allow_write === true;
}

export function canRunCommands(): boolean {
  const config = getPermissionConfig();
  if (config.profile === "open" || config.profile === "workspace") return true;
  if (config.profile === "read_only") return false;
  return config.allow_commands === true;
}

export function canUseUnsafeRuntimes(): boolean {
  const config = getPermissionConfig();
  if (config.profile === "open") return true;
  if (config.profile === "custom") return config.allow_unsafe_runtimes === true;
  return false;
}

export function canUseAnyAbsolutePath(): boolean {
  return getPermissionProfile() === "open";
}

function matchesPattern(command: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, "i").test(command);
  } catch {
    return command.toLowerCase().includes(pattern.toLowerCase());
  }
}

export function shouldBlockCommand(command: string): boolean {
  const config = getPermissionConfig();
  if (!canRunCommands()) return true;
  if (config.command_deny_patterns?.some((pattern) => matchesPattern(command, pattern))) return true;
  if (config.command_allow_patterns?.length) {
    return !config.command_allow_patterns.some((pattern) => matchesPattern(command, pattern));
  }
  return false;
}

export function describePermissionProfile(): string {
  const config = getPermissionConfig();
  if (config.profile === "open") {
    return "open: full machine access through Local ChatGPT Plus tools; paths, commands, and unsafe runtimes are unrestricted (OS ACLs still apply)";
  }
  if (config.profile === "workspace") {
    return `workspace: Local ChatGPT Plus path parameters/cwds are limited to ${getEffectivePathRoots().join(", ")}; writes and commands are allowed, unsafe runtimes are blocked. Command execution is application-level policy, not an OS sandbox.`;
  }
  if (config.profile === "read_only") {
    return `read_only: reads are limited to ${getEffectivePathRoots().join(", ")}; Local ChatGPT Plus writes, commands, and unsafe runtimes are blocked.`;
  }
  return `custom: roots=${getEffectivePathRoots().join(", ") || "none"}; writes=${canWriteFiles()}; commands=${canRunCommands()}; unsafe_runtimes=${canUseUnsafeRuntimes()}. This is application-level policy, not an OS sandbox.`;
}

export function requireWriteAllowed(targetPath?: string): void {
  if (!canWriteFiles()) {
    throw new Error(`Permission denied by '${getPermissionProfile()}' profile: file mutations are disabled`);
  }
  if (targetPath) assertPathAllowed(targetPath);
}

export function requireCommandAllowed(command: string, cwd?: string): void {
  if (cwd) assertPathAllowed(cwd);
  if (shouldBlockCommand(command)) {
    throw new Error(`Permission denied by '${getPermissionProfile()}' profile: command is not allowed: ${command}`);
  }
}

export function requireUnsafeRuntimeAllowed(kind: string): void {
  if (!canUseUnsafeRuntimes()) {
    throw new Error(
      `Permission denied by '${getPermissionProfile()}' profile: ${kind} is an unrestricted runtime and must be explicitly enabled with a custom profile`
    );
  }
}

/** A narrowly scoped Linux exception for a root-owned broker executable.
 * It does not turn on PTY, REPL, direct model CLIs or other unsafe runtimes.
 * Every path component must be owned by root and non-writable by other users;
 * symlinks are refused. The broker itself enforces queue budgets and policy.
 */
export function requireSubagentRunnerAllowed(executable: string): void {
  if (canUseUnsafeRuntimes()) return;
  const policy = getPermissionConfig();
  const trusted = policy.profile === "custom" ? policy.trusted_subagent_executable : undefined;
  if (!trusted || executable !== trusted || process.platform !== "linux") {
    requireUnsafeRuntimeAllowed("subagent runner");
    return;
  }
  try {
    let current = trusted;
    while (true) {
      const info = fs.lstatSync(current);
      if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
        throw new Error("path is not root-owned or is writable by non-root users");
      }
      if (current === trusted && (!info.isFile() || (info.mode & 0o111) === 0)) {
        throw new Error("broker is not an executable regular file");
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch {
    throw new Error("Permission denied: trusted subagent broker must be a root-owned, non-writable executable with trusted parent directories");
  }
}