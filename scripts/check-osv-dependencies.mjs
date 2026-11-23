import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pnpm v11 lockfile package keys (not snapshot keys) are exact registry
// package/version pairs. Keep this dependency-free and fail closed when an
// entry lacks an integrity hash or cannot be interpreted safely.
export function parsePnpmPackages(lock) {
  const match = lock.match(/(?:^|\n)packages:\n([\s\S]*?)(?=\nsnapshots:\n|$)/);
  if (!match) throw new Error("pnpm lockfile has no packages section");

  const lines = match[1].split("\n");
  const packages = [];
  const seen = new Set();
  for (let i = 0; i < lines.length;) {
    const header = lines[i].match(/^  (?:'([^']+)'|([^\s:]+)):\s*$/);
    if (!header) {
      if (lines[i].trim()) throw new Error(`Unknown pnpm package entry at line ${i + 1}`);
      i++;
      continue;
    }

    const key = header[1] || header[2];
    const next = lines.findIndex((line, n) => n > i && /^  \S/.test(line));
    const end = next === -1 ? lines.length : next;
    const entry = lines.slice(i + 1, end).join("\n");
    if (!/^    resolution: \{integrity: sha(?:256|384|512)-[^}\s]+\}/m.test(entry)) {
      throw new Error(`Missing integrity hash for pnpm package: ${key}`);
    }

    const at = key.lastIndexOf("@");
    if (at <= 0 || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(key.slice(at + 1))) {
      throw new Error(`Unexpected pnpm package/version identifier: ${key}`);
    }
    if (seen.has(key)) throw new Error(`Duplicate pnpm package entry: ${key}`);
    seen.add(key);
    packages.push({ name: key.slice(0, at), version: key.slice(at + 1) });
    i = end;
  }
  if (!packages.length) throw new Error("pnpm lockfile has no registry packages");
  return packages;
}

export async function checkOsv(packages, { fetchImpl = fetch, batchSize = 100 } = {}) {
  const findings = [];
  for (let start = 0; start < packages.length; start += batchSize) {
    const batch = packages.slice(start, start + batchSize);
    const response = await fetchImpl("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: batch.map(({ name, version }) => ({ package: { name, ecosystem: "npm" }, version })),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`OSV returned HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.results) || data.results.length !== batch.length) {
      throw new Error("OSV returned an incomplete advisory response");
    }
    for (let i = 0; i < batch.length; i++) {
      for (const vuln of data.results[i].vulns || []) {
        findings.push({ ...batch[i], id: vuln.id });
      }
    }
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const locked = parsePnpmPackages(await fs.readFile(path.join(root, "pnpm-lock.yaml"), "utf8"));
    const findings = await checkOsv(locked);
    console.log(`OSV: checked ${locked.length} pinned npm package/version pairs; ${findings.length} advisory matches`);
    for (const finding of findings) console.error(`OSV: ${finding.name}@${finding.version}: ${finding.id}`);
    if (findings.length) process.exitCode = 1;
  } catch (error) {
    console.error(`OSV: audit incomplete: ${error.message}`);
    process.exitCode = 1;
  }
}