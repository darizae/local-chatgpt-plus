import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// node-pty@1.1.0 ships macOS spawn-helper binaries as mode 0644 in its
// published tarball. A PTY spawn needs execute permission, so we repair only
// the helper for the current OS/architecture (and its source-build fallback).
// Do not follow a final-component symlink or chmod a shared hardlink in-place.
export async function fixNodePtyPermissions({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  platform = process.platform,
  arch = process.arch,
  log = console.log,
} = {}) {
  if (platform === "win32") return [];
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("Cannot safely repair node-pty permissions: O_NOFOLLOW is unavailable");
  }

  const candidates = [
    path.join(root, "node_modules", "node-pty", "prebuilds", `${platform}-${arch}`, "spawn-helper"),
    path.join(root, "node_modules", "node-pty", "build", "Release", "spawn-helper"),
  ];
  const changed = [];

  for (const candidate of candidates) {
    let helper;
    try {
      helper = await fs.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await helper.stat();
      if (!stat.isFile() || (stat.mode & 0o111) !== 0) continue;

      const desiredMode = (stat.mode & 0o777) | 0o111;
      if (stat.nlink > 1) {
        // pnpm may install files as hardlinks to its content-addressed store.
        // Replace the link with a separate inode rather than altering a shared
        // store entry. The file contents come from the already-opened handle.
        const temporary = path.join(
          path.dirname(candidate),
          `.spawn-helper.lcp-${process.pid}-${randomBytes(8).toString("hex")}`,
        );
        let output;
        try {
          if (stat.size > 5_000_000) throw new Error("Unexpectedly large node-pty spawn-helper");
          output = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, stat.mode & 0o777);
          await output.writeFile(await helper.readFile());
          await output.chmod(desiredMode);
          await output.close();
          output = undefined;
          await fs.rename(temporary, candidate);
        } finally {
          if (output) await output.close();
          await fs.rm(temporary, { force: true });
        }
      } else {
        // chmod the opened descriptor, not the pathname: a swapped symlink
        // cannot redirect the operation onto an unrelated file.
        await helper.chmod(desiredMode);
      }
      changed.push(path.relative(root, candidate));
      log(`[postinstall] Enabled node-pty helper: ${path.relative(root, candidate)}`);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) continue;
      throw error;
    } finally {
      if (helper) await helper.close();
    }
  }
  return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fixNodePtyPermissions();
}