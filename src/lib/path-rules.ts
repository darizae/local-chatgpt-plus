import fs from "fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "path";
import { StringDecoder } from "node:string_decoder";

function parseFrontmatter(content: string): { paths?: string[] } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const pathsLine = match[1].match(/^paths:\s*\n((?:\s+-\s*.+\n?)+)/m);
  if (!pathsLine) return {};
  const paths = [...pathsLine[1].matchAll(/^\s+-\s*["']?([^"'\n]+)["']?\s*$/gm)].map((m) => m[1].trim());
  return { paths };
}

function globToRegex(glob: string): RegExp {
  // Single pass so {a,b} alternates are expanded without the later escape step
  // turning their generated `(a|b)` metacharacters back into literals.
  const scan = (s: string): string => {
    let re = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "{") {
        let close = i + 1;
        let depth = 0;
        for (; close < s.length; close++) {
          if (s[close] === "{") depth++;
          else if (s[close] === "}" && depth-- === 0) break;
        }
        if (close >= s.length) { re += "\\{"; continue; } // unclosed brace -> literal
        const alts = s.slice(i + 1, close).split(",").map((a) => a.trim()).filter(Boolean);
        re += "(" + alts.map((a) => scan(a)).join("|") + ")";
        i = close;
      } else if (ch === "*") {
        if (s[i + 1] === "*") { re += ".*"; i++; } else re += "[^/\\\\]*";
      } else if (ch === "?") re += ".";
      else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return re;
  };
  return new RegExp(`^${scan(glob)}$`, "i");
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  const norm = filePath.replace(/\\/g, "/");
  return patterns.some((p) => globToRegex(p).test(norm) || globToRegex(p).test(path.basename(norm)));
}

async function listRuleFiles(rulesDir: string): Promise<string[]> {
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
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push(full);
    }
  }
  await walk(rulesDir, 0);
  // Deterministic (lexicographic) rule order so precedence does not depend on
  // filesystem readdir order.
  return found.sort();
}

/**
 * Read only enough of a matching rule to return its 4,000-character body prefix.
 * The complete frontmatter is still parsed; a long but valid header therefore
 * retains its former behavior. Read to EOF only when necessary to determine
 * whether trailing whitespace belongs to the final trimmed content.
 */
async function readMatchingRulePrefix(ruleFile: string, targetPaths: string[]): Promise<string | null> {
  // Defense in depth: a symlink can appear after directory enumeration.
  // Never read a rule through a symlink, even when the name ends in .md.
  const stat = await fs.lstat(ruleFile);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  // O_NOFOLLOW closes the lstat/open race on macOS: a link introduced
  // between the two calls must still be rejected by the kernel.
  const handle = await fs.open(ruleFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(8192);
  let raw = "";
  let headerLength: number | null = null;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      raw += decoder.write(buffer.subarray(0, bytesRead));
      if (headerLength === null) {
        if (raw.length >= 5 && !raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return null;
        const header = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        if (!header) continue;
        const fm = parseFrontmatter(raw);
        if (!fm.paths?.length || !targetPaths.some((target) => matchesAny(target, fm.paths!))) return null;
        headerLength = header[0].length;
      }
      const prefix = raw.slice(headerLength).trimStart();
      // A non-whitespace character after the first 4,000 proves that a
      // subsequent trimEnd cannot alter those 4,000 characters.
      if (prefix.length > 4000 && /\S/.test(prefix.slice(4000))) return prefix.slice(0, 4000);
    }
    raw += decoder.end();
    if (headerLength === null) return null;
    return raw.slice(headerLength).trim().slice(0, 4000) || null;
  } finally {
    await handle.close();
  }
}

export async function loadPathRulesForFile(
  workspaceRoot: string,
  filePath: string
): Promise<Array<{ path: string; content: string }>> {
  const rulesDir = path.join(workspaceRoot, ".claude", "rules");
  const matched: Array<{ path: string; content: string }> = [];

  for (const ruleFile of await listRuleFiles(rulesDir)) {
    try {
      // Rule frontmatter globs are normally relative to their project root.
      // Keep absolute-path matching as a compatibility fallback.
      const relative = path.relative(workspaceRoot, filePath);
      const scopedPath = relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        ? relative : filePath;
      const body = await readMatchingRulePrefix(ruleFile,
        scopedPath === filePath ? [filePath] : [scopedPath, filePath]);
      if (body) matched.push({ path: ruleFile, content: body });
    } catch {}
  }

  return matched;
}