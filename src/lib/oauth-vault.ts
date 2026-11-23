import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { atomicWriteText } from "./atomic-file.js";

interface SealedStore {
  version: 1;
  algorithm: "aes-256-gcm";
  nonce: string;
  ciphertext: string;
  tag: string;
}

function decodeBase64(value: unknown, size?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("Invalid encrypted OAuth store");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (size !== undefined && bytes.length !== size)) {
    throw new Error("Invalid encrypted OAuth store");
  }
  return bytes;
}

/** The key is provisioned by the operator; it is never generated beside ciphertext. */
export async function loadOAuthKey(variable = "MCP_OAUTH_ENCRYPTION_KEY_FILE"): Promise<Buffer | undefined> {
  const keyPath = process.env[variable]?.trim();
  if (!keyPath) return undefined;
  let handle;
  try {
    const stat = await fs.lstat(keyPath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("OAuth encryption key must be a private regular file (mode 0600)");
    // Never follow a substituted symlink between lstat and open. The
    // subsequent device/inode check also rejects a replacement regular file.
    handle = await fs.open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const actual = await handle.stat();
    if (!actual.isFile() || actual.ino !== stat.ino || actual.dev !== stat.dev || (actual.mode & 0o077) !== 0) {
      throw new Error("OAuth encryption key changed or permissions are unsafe");
    }
    const encoded = (await handle.readFile("utf8")).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(encoded)) throw new Error("OAuth encryption key must contain 64 hex characters");
    return Buffer.from(encoded, "hex");
  } catch {
    throw new Error("OAuth encryption key is missing or invalid; refusing to read or persist OAuth state");
  } finally {
    await handle?.close();
  }
}

/** Read during an explicitly configured key-rotation window. The old key is
 * never used to encrypt newly persisted state. */
export async function loadPreviousOAuthKey(): Promise<Buffer | undefined> {
  return loadOAuthKey("MCP_OAUTH_PREVIOUS_KEY_FILE");
}

function aad(storePath: string): Buffer {
  // Binding to the server's filename rejects swapping credentials across servers.
  return Buffer.from("local-chatgpt-plus/oauth-store/v1/" + storePath.split(/[\\/]/).pop(), "utf8");
}

export function sealOAuthStore(value: unknown, key: Buffer, storePath: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad(storePath));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const envelope: SealedStore = {
    version: 1, algorithm: "aes-256-gcm", nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
  };
  return JSON.stringify(envelope);
}

export function openOAuthStore(text: string, key: Buffer | undefined, storePath: string): unknown {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid OAuth store");
  const record = parsed as Record<string, unknown>;
  if (record.version === undefined && record.algorithm === undefined) {
    if (key && process.env.MCP_OAUTH_ALLOW_PLAINTEXT_MIGRATION !== "true") {
      throw new Error("Plaintext OAuth state exists; explicit migration approval is required");
    }
    return parsed;
  }
  if (record.version !== 1 || record.algorithm !== "aes-256-gcm" || !key) {
    throw new Error("Encrypted OAuth state requires a valid encryption key and supported version");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, decodeBase64(record.nonce, 12), { authTagLength: 16 });
  decipher.setAAD(aad(storePath));
  decipher.setAuthTag(decodeBase64(record.tag, 16));
  try {
    const plain = Buffer.concat([decipher.update(decodeBase64(record.ciphertext)), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    throw new Error("OAuth state authentication failed");
  }
}

export async function saveOAuthStore(storePath: string, value: unknown, key: Buffer | undefined): Promise<void> {
  if (!key) {
    // Existing plaintext installations remain supported until the operator
    // provisions a key; encrypted stores can never be downgraded silently.
    await atomicWriteText(storePath, JSON.stringify(value, null, 2), { mode: 0o600 });
    return;
  }
  await atomicWriteText(storePath, sealOAuthStore(value, key, storePath), { mode: 0o600 });
}