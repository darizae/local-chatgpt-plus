import fs from "fs/promises";
import os from "os";
import path from "path";
import { StringDecoder } from "node:string_decoder";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const ROOT_MEMORY_FILES = [
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "AGENTS.md",
  "CLAUDE.local.md",
] as const;

const USER_MEMORY_CANDIDATES = [
  path.join(os.homedir(), ".codex", "CLAUDE.md"),
  path.join(os.homedir(), ".claude", "CLAUDE.md"),
] as const;

const RULES_GLOB_MAX = 12;
const IMPORT_MAX_DEPTH = 4;
const DEFAULT_MAX_BYTES = parseInt(process.env.PROJECT_MEMORY_MAX_BYTES || "25000", 10);
const DEFAULT_MAX_LINES = parseInt(process.env.PROJECT_MEMORY_MAX_LINES || "200", 10);

export interface ProjectMemorySection {
  path: string;
  content: string;
  truncated: boolean;
  kind: "user" | "project" | "rule" | "import";
}

export interface ProjectMemoryBundle {
  root: string;
  workspace_roots: string[];
  sections: ProjectMemorySection[];
  total_bytes: number;
  loaded_at: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasPathsFrontmatter(filePath: string): Promise<boolean> {
  const input = createReadStream(filePath, { encoding: "utf8", highWaterMark: 8192 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let index = 0;
  let hasPaths = false;
  try {
    for await (const line of lines) {
      if (index++ === 0) {
        if (line !== "---") return false;
      } else if (line.startsWith("---")) {
        // The previous regex requires a newline before the closing delimiter.
        return index > 2 && hasPaths;
      } else if (/^paths\s*:/.test(line)) {
        hasPaths = true;
      }
    }
    return false; // A missing closing delimiter is not valid frontmatter.
  } finally {
    lines.close();
    input.destroy();
  }
}

/**
 * Strip complete HTML comments without keeping the entire source in memory.
 * An unterminated comment is literal text (matching stripHtmlComments's old
 * regular expression), so retain only the prefix that could reach the caller.
 */
async function* strippedFileChunks(filePath: string, maxChars: number): AsyncGenerator<string> {
  const handle = await fs.open(filePath, "r");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(8192);
  let carry = "";
  let inComment = false;
  let unclosedPrefix = "";

  function* consume(chunk: string, end = false): Generator<string> {
    let source = carry + chunk;
    carry = "";
    while (source) {
      if (!inComment) {
        const start = source.indexOf("<!--");
        if (start >= 0) {
          if (start) yield source.slice(0, start);
          source = source.slice(start + 4);
          inComment = true;
          unclosedPrefix = "<!--";
          continue;
        }
        const safe = end ? source.length : Math.max(0, source.length - 3);
        if (safe) yield source.slice(0, safe);
        carry = source.slice(safe);
        break;
      }
      const close = source.indexOf("-->");
      if (close >= 0) {
        source = source.slice(close + 3);
        inComment = false;
        unclosedPrefix = "";
        continue;
      }
      const safe = end ? source.length : Math.max(0, source.length - 2);
      if (unclosedPrefix.length < maxChars) {
        unclosedPrefix += source.slice(0, Math.min(safe, maxChars - unclosedPrefix.length));
      }
      carry = source.slice(safe);
      break;
    }
    if (end) {
      if (inComment) yield unclosedPrefix;
      else if (carry) yield carry;
      carry = "";
    }
  }

  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      yield* consume(decoder.write(buffer.subarray(0, bytesRead)));
    }
    yield* consume(decoder.end(), true);
  } finally {
    await handle.close();
  }
}

interface MemoryLine { text: string; separator: string; partial?: boolean }

/** Keeps at most maxChars of an overlong line, enough to fill the output cap. */
async function* strippedFileLines(filePath: string, maxChars: number): AsyncGenerator<MemoryLine> {
  let pending = "";
  for await (const chunk of strippedFileChunks(filePath, maxChars)) {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const crlf = newline > 0 && pending[newline - 1] === "\r";
      yield { text: pending.slice(0, crlf ? newline - 1 : newline), separator: crlf ? "\r\n" : "\n" };
      pending = pending.slice(newline + 1);
    }
    if (pending.length > maxChars) {
      yield { text: pending.slice(0, maxChars), separator: "", partial: true };
      return;
    }
  }
  yield { text: pending, separator: "" };
}

/**
 * Expand only the visible prefix of imported files, preserving the legacy
 * depth, global visited-set semantics, fence handling and import markers.
 */
async function* expandMemoryFile(
  filePath: string,
  visited: Set<string>,
  depth: number,
  maxChars: number
): AsyncGenerator<string> {
  let inFence = false;
  for await (const line of strippedFileLines(filePath, maxChars)) {
    if (depth >= IMPORT_MAX_DEPTH) {
      yield line.text + line.separator; // At the depth limit, imports and CRLF remain literal.
      if (line.partial) return;
      continue;
    }
    if (line.text.trim().startsWith("```")) {
      inFence = !inFence;
      yield line.text;
    } else {
      const match = !inFence && line.text.match(/^@(~\/[^\s`]+|[^\s`]+)\s*$/);
      if (!match || line.partial) {
        yield line.text;
      } else {
        const importPath = match[1].startsWith("~/")
          ? path.join(os.homedir(), match[1].slice(2))
          : path.isAbsolute(match[1]) ? match[1] : path.resolve(path.dirname(filePath), match[1]);
        const resolved = path.resolve(importPath);
        if (visited.has(resolved)) {
          yield `<!-- skipped circular import ${resolved} -->`;
        } else {
          visited.add(resolved);
          let readable = false;
          try {
            readable = (await fs.stat(resolved)).isFile();
            if (readable) await fs.access(resolved);
          } catch {
            readable = false;
          }
          if (!readable) {
            yield `<!-- import failed: ${resolved} -->`;
          } else {
            yield `<!-- @import ${resolved} -->\n`;
            yield* expandMemoryFile(resolved, visited, depth + 1, maxChars);
          }
        }
      }
    }
    if (line.separator) yield "\n";
    if (line.partial) return;
  }
}

async function readTextLimited(
  filePath: string,
  maxBytes: number,
  maxLines: number,
  kind: ProjectMemorySection["kind"]
): Promise<ProjectMemorySection | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 ||
    !Number.isSafeInteger(maxLines) || maxLines <= 0) return null;
  try {
    const stat = await fs.stat(filePath);
    const maxChars = maxBytes + 8192;
    let expanded = "";
    let stoppedEarly = false;
    for await (const chunk of expandMemoryFile(filePath, new Set<string>(), 0, maxChars)) {
      expanded += chunk;
      const lines = expanded.split(/\r?\n/);
      if (lines.length > maxLines || Buffer.byteLength(lines.join("\n"), "utf8") > maxBytes + 8) {
        stoppedEarly = true;
        break;
      }
    }

    const lines = expanded.split(/\r?\n/).slice(0, maxLines);
    const lineLimited = lines.join("\n");
    const byteLimited = Buffer.byteLength(lineLimited, "utf8") > maxBytes
      ? Buffer.from(lineLimited, "utf8").subarray(0, maxBytes).toString("utf8")
      : lineLimited;
    const truncated = stat.size > maxBytes || stoppedEarly ||
      expanded.split(/\r?\n/).length > maxLines || byteLimited.length < expanded.length;
    const trimmed = byteLimited.trim();
    if (!trimmed) return null;
    return { path: filePath, content: trimmed, truncated, kind };
  } catch {
    return null;
  }
}

async function listUnconditionalRuleFiles(rulesDir: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          if (!(await hasPathsFrontmatter(full))) found.push(full);
        } catch {}
      }
    }
  }

  await walk(rulesDir, 0);
  return found.sort().slice(0, RULES_GLOB_MAX);
}

async function appendSection(
  sections: ProjectMemorySection[],
  totalBytes: { value: number },
  maxBytes: number,
  maxLines: number,
  filePath: string,
  kind: ProjectMemorySection["kind"]
): Promise<void> {
  if (totalBytes.value >= maxBytes) return;
  const section = await readTextLimited(
    filePath,
    maxBytes - totalBytes.value,
    maxLines,
    kind
  );
  if (!section?.content) return;
  sections.push(section);
  totalBytes.value += Buffer.byteLength(section.content, "utf-8");
}

export async function loadProjectMemory(
  workspaceRoot: string,
  opts?: { maxBytes?: number; maxLines?: number; workspaceRoots?: string[] }
): Promise<ProjectMemoryBundle> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  const root = path.resolve(workspaceRoot);
  const workspace_roots = opts?.workspaceRoots ?? [root];
  const sections: ProjectMemorySection[] = [];
  const totalBytes = { value: 0 };

  for (const userPath of USER_MEMORY_CANDIDATES) {
    if (!(await fileExists(userPath))) continue;
    await appendSection(sections, totalBytes, maxBytes, maxLines, userPath, "user");
    break;
  }

  for (const rel of ROOT_MEMORY_FILES) {
    const filePath = path.join(root, rel);
    if (!(await fileExists(filePath))) continue;
    await appendSection(sections, totalBytes, maxBytes, maxLines, filePath, "project");
  }

  const rulesDir = path.join(root, ".claude", "rules");
  if (totalBytes.value < maxBytes && (await fileExists(rulesDir))) {
    for (const ruleFile of await listUnconditionalRuleFiles(rulesDir)) {
      await appendSection(sections, totalBytes, maxBytes, maxLines, ruleFile, "rule");
    }
  }

  return {
    root,
    workspace_roots,
    sections,
    total_bytes: totalBytes.value,
    loaded_at: new Date().toISOString(),
  };
}

export function formatProjectMemoryForInstructions(bundle: ProjectMemoryBundle): string {
  if (bundle.sections.length === 0) {
    return [
      "## Project memory",
      `No CLAUDE.md or AGENTS.md at ${bundle.root}.`,
      "Create CLAUDE.md in the project root (run /init in Claude Code or write manually).",
      "For another repo: call project_context(path) with the absolute project path.",
      bundle.workspace_roots.length > 1
        ? `Configured workspace roots:\n${bundle.workspace_roots.map((r) => `- ${r}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const blocks = bundle.sections.map((s) => {
    const note = s.truncated ? " (truncated)" : "";
    const label =
      s.kind === "user"
        ? "User memory"
        : s.kind === "rule"
          ? "Rule"
          : s.kind === "import"
            ? "Import"
            : "Project";
    return `### ${label}: ${s.path}${note}\n${s.content}`;
  });

  return [
    "## Project memory (auto-loaded like Claude Code CLAUDE.md)",
    `Primary root: ${bundle.root}`,
    "Treat content below as ground truth for conventions, build commands, and architecture.",
    bundle.workspace_roots.length > 1
      ? `All workspace roots:\n${bundle.workspace_roots.map((r) => `- ${r}`).join("\n")}`
      : "",
    "",
    ...blocks,
  ]
    .filter(Boolean)
    .join("\n");
}