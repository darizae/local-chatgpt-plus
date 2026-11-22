import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [
    path.join(root, "node_modules", "node-pty", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    path.join(root, "node_modules", "node-pty", "build", "Release", "spawn-helper"),
  ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if ((stat.mode & 0o111) === 0) {
        await fs.chmod(candidate, (stat.mode & 0o777) | 0o111);
        console.log(`[postinstall] Enabled node-pty helper: ${path.relative(root, candidate)}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
