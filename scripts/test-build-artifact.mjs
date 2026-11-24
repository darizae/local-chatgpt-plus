import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compiledArtifactDigest, readArtifactCommit } from "../dist/lib/build-artifact.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcp-artifact-"));
try {
  fs.writeFileSync(path.join(dir, "index.js"), "export const value = 1;\n");
  fs.mkdirSync(path.join(dir, "lib"));
  fs.writeFileSync(path.join(dir, "lib", "x.js"), "export const x = 1;\n");
  assert.equal(readArtifactCommit(dir), null);
  const digest = compiledArtifactDigest(dir);
  fs.writeFileSync(path.join(dir, ".lcp-build.json"), JSON.stringify({version: 1, commit: "012345abcdef", digest}));
  assert.equal(readArtifactCommit(dir), "012345abcdef");
  fs.writeFileSync(path.join(dir, "lib", "x.js"), "export const x = 2;\n");
  assert.equal(readArtifactCommit(dir), null);
  console.log("Artifact identity: clean stamp accepted; stale/mutated JS rejected");
} finally {
  fs.rmSync(dir, {recursive:true,force:true});
}
