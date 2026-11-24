import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export function compiledArtifactDigest(directory: string): string {
  const hash = createHash("sha256");
  let files = 0;
  function visit(relative: string): void {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Unexpected symlink in compiled artifact");
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        files++;
        const bytes = fs.readFileSync(path.join(directory, name));
        hash.update(name.split(path.sep).join("/")).update("\0").update(String(bytes.length)).update("\0").update(bytes);
      }
    }
  }
  visit("");
  if (!files || !fs.statSync(path.join(directory, "index.js")).isFile()) throw new Error("No compiled application");
  return hash.digest("hex");
}

/** Operational provenance, not a signature or a trust boundary against the build account. */
export function readArtifactCommit(directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")): string | null {
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(directory, ".lcp-build.json"), "utf8"));
    return stamp.version === 1 && /^[0-9a-f]{12}$/.test(stamp.commit) &&
      stamp.digest === compiledArtifactDigest(directory) ? stamp.commit : null;
  } catch { return null; }
}
