#!/usr/bin/env node
/** HEAD-only, offline publication secret tripwire. Never prints matching values. */
import { execFileSync } from "node:child_process";
import { SYNTHETIC_JWT } from "./synthetic-secret-fixtures.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (args, options = {}) => execFileSync("git", args, {
  cwd: root, encoding: "buffer", maxBuffer: 30 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], ...options,
});
const patterns = [
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9]{20,}\b/g],
  ["GitHub PAT", /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["Private key header", /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g],
  ["Signed JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
];
const examples = new Set([
  "AKIAIOSFODNN7EXAMPLE",
  "sk-abcdefghijklmnopqrstuvwxyz123456",
  "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
  "xoxb-1234567890-abcdefghijkl",
  SYNTHETIC_JWT,
]);
let hits=0, scanned=0;
const files=git(["ls-tree","-r","-z","--name-only","HEAD"]).toString("utf8").split("\0").filter(Boolean);
for(const file of files){
  let blob;
  try { blob=git(["show", `HEAD:${file}`]); } catch { throw new Error("Unable to read tracked HEAD blob"); }
  if(blob.includes(0) || blob.length > 5_000_000) continue;
  scanned++;
  for(const [lineNo, line] of blob.toString("utf8").split("\n").entries()){
    // Security-scanner source defines PEM matching regexes; a literal regex
    // declaration is not itself a PEM key. All other lines remain scanned.
    if(file === "scripts/audit-git-history.mjs" && /re:\s*\/-----BEGIN/.test(line)) continue;
    for(const [kind,re] of patterns){
      re.lastIndex=0;
      for(const match of line.matchAll(re)){
        if(examples.has(match[0]))continue;
        console.log(`Potential ${kind} in tracked HEAD: ${file}:${lineNo+1}`);
        hits++;
      }
    }
  }
}
console.log(`Scanned ${scanned} tracked text files at HEAD; potential secrets: ${hits}`);
if(hits) process.exit(1);
