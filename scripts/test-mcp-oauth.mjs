import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { FileOAuthClientProvider } from "../dist/lib/mcp-oauth-provider.js";
import { openOAuthStore, sealOAuthStore } from "../dist/lib/oauth-vault.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-oauth-"));
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`OK  ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

const make = () => new FileOAuthClientProvider({
  serverId: "test-server",
  authDir: dir,
  callbackBase: "http://127.0.0.1:3999",
  openBrowser: false,
});

await test("oauth state persists across provider instances", async () => {
  const a = make();
  await a.beginAuthorization();
  const state = await a.state();
  assert.equal(await a.verifyState(state), true);
  const b = make();
  assert.equal(await b.verifyState(state), true);
  assert.equal(await b.verifyState("wrong"), false);
});

await test("oauth client info, verifier and tokens persist", async () => {
  const a = make();
  await a.saveClientInformation({ client_id: "client-1" });
  await a.saveCodeVerifier("verifier-1");
  await a.saveTokens({ access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1" });
  const b = make();
  assert.equal((await b.clientInformation())?.client_id, "client-1");
  assert.equal(await b.codeVerifier(), "verifier-1");
  assert.equal((await b.tokens())?.access_token, "access-1");
  assert.equal((await b.authorizationStatus()).connected, true);
});

await test("oauth disconnect removes tokens without client registration", async () => {
  const a = make();
  await a.invalidateCredentials("tokens");
  assert.equal(await a.tokens(), undefined);
  assert.equal((await a.clientInformation())?.client_id, "client-1");
});

await test("oauth persistence uses a complete parseable store with no temp residue", async () => {
  const a = make();
  await a.beginAuthorization();
  await a.saveTokens({ access_token: "access-atomic", token_type: "Bearer", refresh_token: "refresh-atomic" });
  const files = await fs.readdir(dir);
  assert.equal(files.some((name) => name.endsWith(".tmp")), false);
  const store = JSON.parse(await fs.readFile(path.join(dir, "test-server.json"), "utf-8"));
  assert.equal(store.tokens?.access_token, "access-atomic");
});

await test("versioned AES-GCM OAuth vault rejects tamper, swaps and wrong keys", async () => {
  const key = randomBytes(32);
  const other = randomBytes(32);
  const sealed = sealOAuthStore({ tokens: { access_token: "synthetic-opaque-token" } }, key, "one.json");
  assert.equal(sealed.includes("synthetic-opaque-token"), false);
  assert.equal(openOAuthStore(sealed, key, "one.json").tokens.access_token, "synthetic-opaque-token");
  assert.throws(() => openOAuthStore(sealed, other, "one.json"), /authentication failed/);
  assert.throws(() => openOAuthStore(sealed, key, "two.json"), /authentication failed/);
  const damaged = JSON.parse(sealed);
  damaged.ciphertext = Buffer.from("tampered").toString("base64");
  assert.throws(() => openOAuthStore(JSON.stringify(damaged), key, "one.json"), /authentication failed/);
  assert.throws(() => openOAuthStore(sealed, undefined, "one.json"), /requires a valid encryption key/);
});

await test("encrypted OAuth provider persists no plaintext and fails closed on key loss", async () => {
  const vaultDir = await fs.mkdtemp(path.join(dir, "sealed-"));
  const keyPath = path.join(vaultDir, "key");
  await fs.writeFile(keyPath, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  const previous = process.env.MCP_OAUTH_ENCRYPTION_KEY_FILE;
  process.env.MCP_OAUTH_ENCRYPTION_KEY_FILE = keyPath;
  const provider = () => new FileOAuthClientProvider({ serverId: "sealed", authDir: vaultDir, openBrowser: false });
  try {
    await provider().saveTokens({ access_token: "synthetic-secret", token_type: "Bearer" });
    const text = await fs.readFile(path.join(vaultDir, "sealed.json"), "utf8");
    assert.equal(text.includes("synthetic-secret"), false);
    assert.equal((await provider().tokens()).access_token, "synthetic-secret");
    await fs.chmod(keyPath, 0o644);
    await assert.rejects(() => provider().tokens(), /encryption key is missing or invalid/);
    await assert.rejects(
      () => provider().saveTokens({ access_token: "synthetic-denied", token_type: "Bearer" }),
      /encryption key is missing or invalid/,
    );
    assert.equal((await fs.readFile(path.join(vaultDir, "sealed.json"), "utf8")).includes("synthetic-denied"), false);
    await fs.chmod(keyPath, 0o600);
    await fs.writeFile(keyPath, randomBytes(32).toString("hex") + "\n");
    await assert.rejects(() => provider().tokens(), /authentication failed/);
  } finally {
    if (previous === undefined) delete process.env.MCP_OAUTH_ENCRYPTION_KEY_FILE;
    else process.env.MCP_OAUTH_ENCRYPTION_KEY_FILE = previous;
  }
});

await test("plaintext migration requires explicit operator consent", async () => {
  const vaultDir = await fs.mkdtemp(path.join(dir, "legacy-"));
  const keyPath = path.join(vaultDir, "key");
  const storePath = path.join(vaultDir, "legacy.json");
  await fs.writeFile(storePath, JSON.stringify({ tokens: { access_token: "synthetic-legacy", token_type: "Bearer" } }), { mode: 0o600 });
  await fs.writeFile(keyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  const previous = process.env.MCP_OAUTH_ENCRYPTION_KEY_FILE;
  process.env.MCP_OAUTH_ENCRYPTION_KEY_FILE = keyPath;
  const makeLegacy = () => new FileOAuthClientProvider({ serverId: "legacy", authDir: vaultDir, openBrowser: false });
  try {
    await assert.rejects(() => makeLegacy().tokens(), /explicit migration approval/);
    assert.match(await fs.readFile(storePath, "utf8"), /synthetic-legacy/);
    process.env.MCP_OAUTH_ALLOW_PLAINTEXT_MIGRATION = "true";
    assert.equal((await makeLegacy().tokens()).access_token, "synthetic-legacy");
    assert.equal((await fs.readFile(storePath, "utf8")).includes("synthetic-legacy"), false);
  } finally {
    delete process.env.MCP_OAUTH_ALLOW_PLAINTEXT_MIGRATION;
    if (previous === undefined) delete process.env.MCP_OAUTH_ENCRYPTION_KEY_FILE;
    else process.env.MCP_OAUTH_ENCRYPTION_KEY_FILE = previous;
  }
});

await test("staged OAuth key rotation rewraps old ciphertext with the new key", async () => {
  const vaultDir = await fs.mkdtemp(path.join(dir, "rotation-"));
  const oldKeyPath = path.join(vaultDir, "old.key");
  const newKeyPath = path.join(vaultDir, "new.key");
  await fs.writeFile(oldKeyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  await fs.writeFile(newKeyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  const prior = process.env.MCP_OAUTH_ENCRYPTION_KEY_FILE;
  const priorPrevious = process.env.MCP_OAUTH_PREVIOUS_KEY_FILE;
  const provider = () => new FileOAuthClientProvider({ serverId: "rotate", authDir: vaultDir, openBrowser: false });
  try {
    process.env.MCP_OAUTH_ENCRYPTION_KEY_FILE = oldKeyPath;
    await provider().saveTokens({ access_token: "synthetic-rotated-token", token_type: "Bearer" });
    process.env.MCP_OAUTH_ENCRYPTION_KEY_FILE = newKeyPath;
    await assert.rejects(() => provider().tokens(), /authentication failed/);
    process.env.MCP_OAUTH_PREVIOUS_KEY_FILE = oldKeyPath;
    assert.equal((await provider().tokens()).access_token, "synthetic-rotated-token");
    delete process.env.MCP_OAUTH_PREVIOUS_KEY_FILE;
    assert.equal((await provider().tokens()).access_token, "synthetic-rotated-token");
    process.env.MCP_OAUTH_ENCRYPTION_KEY_FILE = oldKeyPath;
    await assert.rejects(() => provider().tokens(), /authentication failed/);
  } finally {
    if (prior === undefined) delete process.env.MCP_OAUTH_ENCRYPTION_KEY_FILE;
    else process.env.MCP_OAUTH_ENCRYPTION_KEY_FILE = prior;
    if (priorPrevious === undefined) delete process.env.MCP_OAUTH_PREVIOUS_KEY_FILE;
    else process.env.MCP_OAUTH_PREVIOUS_KEY_FILE = priorPrevious;
  }
});

await fs.rm(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, 0 failed`);