import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixNodePtyPermissions } from "./fix-node-pty-permissions.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcp-pty-permissions-"));
const pkg = path.join(root, "node_modules", "node-pty");
const helper = path.join(pkg, "prebuilds", "darwin-arm64", "spawn-helper");
const fallback = path.join(pkg, "build", "Release", "spawn-helper");
const unrelated = path.join(root, "unrelated");
const log = [];
const options = { root, platform: "darwin", arch: "arm64", log: (message) => log.push(message) };
const mode = async (file) => (await fs.stat(file)).mode & 0o777;

try {
  await fs.mkdir(path.dirname(helper), { recursive: true });
  await fs.mkdir(path.dirname(fallback), { recursive: true });
  await fs.writeFile(helper, "prebuilt", { mode: 0o644 });
  await fs.chmod(helper, 0o644);
  await fs.writeFile(unrelated, "unchanged", { mode: 0o644 });
  await fs.chmod(unrelated, 0o644);

  assert.deepEqual(await fixNodePtyPermissions(options), [
    "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
  ]);
  assert.equal(await mode(helper), 0o755);
  assert.equal(await mode(unrelated), 0o644);
  assert.deepEqual(await fixNodePtyPermissions(options), []);

  // An attacker-controlled link must not cause a chmod outside node-pty.
  await fs.unlink(helper);
  await fs.symlink(unrelated, helper);
  assert.deepEqual(await fixNodePtyPermissions(options), []);
  assert.equal(await mode(unrelated), 0o644);
  assert.equal((await fs.lstat(helper)).isSymbolicLink(), true);

  // The source-build fallback also needs execute permission, when present.
  await fs.writeFile(fallback, "fallback", { mode: 0o644 });
  await fs.chmod(fallback, 0o644);
  assert.deepEqual(await fixNodePtyPermissions(options), [
    "node_modules/node-pty/build/Release/spawn-helper",
  ]);
  assert.equal(await mode(fallback), 0o755);

  // Hardlinked package content must not change the original store inode.
  await fs.unlink(helper);
  const storeCopy = path.join(root, "store-copy");
  await fs.writeFile(storeCopy, "shared", { mode: 0o644 });
  await fs.chmod(storeCopy, 0o644);
  await fs.link(storeCopy, helper);
  assert.deepEqual(await fixNodePtyPermissions(options), [
    "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
  ]);
  assert.equal(await mode(helper), 0o755);
  assert.equal(await mode(storeCopy), 0o644);
  assert.notEqual((await fs.stat(helper)).ino, (await fs.stat(storeCopy)).ino);
  assert.equal(await fs.readFile(helper, "utf8"), "shared");

  assert.deepEqual(await fixNodePtyPermissions({ ...options, platform: "win32" }), []);
  assert.equal(log.length, 3);
  console.log("node-pty postinstall: regular, idempotent, symlink, fallback, hardlink, Windows checks passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}