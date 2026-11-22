import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Router, type Request, type RequestHandler, type Response } from "express";
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { atomicWriteText } from "../lib/atomic-file.js";

const RP_ID = "localhost";
const CHALLENGE_MS = 120_000;
const MAX_PASSKEYS = 8;
const MAX_PENDING = 64;
const CHALLENGE_COOKIE = "lcp_admin_passkey_challenge";

type StoredPasskey = {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  createdAt: string;
};
type PasskeyFile = {
  version: 1;
  userID: string;
  credentials: StoredPasskey[];
};
type Pending = { challenge: string; expires: number };
type AdminSession = { id: string; viaToken: boolean };

function decodePasskeyFile(input: unknown): PasskeyFile {
  const file = input as Partial<PasskeyFile> | null;
  const encoded = (s: unknown) => typeof s === "string" && /^[A-Za-z0-9_-]{1,2048}$/.test(s);
  if (!file || file.version !== 1 || !encoded(file.userID) || !Array.isArray(file.credentials) ||
      file.credentials.length > MAX_PASSKEYS || !file.credentials.every((entry) =>
        entry && encoded(entry.id) && encoded(entry.publicKey) &&
        Number.isSafeInteger(entry.counter) && entry.counter >= 0 &&
        /^\d{4}-\d\d-\d\dT/.test(entry.createdAt) &&
        (entry.transports === undefined || (Array.isArray(entry.transports) &&
          entry.transports.length <= 8 && entry.transports.every((t) =>
            typeof t === "string" && /^[a-z-]{1,25}$/.test(t)))))) {
    throw new Error("Invalid Admin passkey registry; refusing to start Admin");
  }
  return file as PasskeyFile;
}

function readStore(filePath: string): PasskeyFile {
  try {
    const metadata = fs.lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 ||
        metadata.size > 65_536) {
      throw new Error("Admin passkey registry must be a private regular file (0600)");
    }
    return decodePasskeyFile(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, userID: randomBytes(32).toString("base64url"), credentials: [] };
    }
    throw error;
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw || raw.length > 8192) return undefined;
  return raw.split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="))?.slice(name.length + 1);
}

function localhostOrigin(req: Request): string | undefined {
  // WebAuthn RP IDs are DNS domains, not numeric IPv4/IPv6 addresses.
  // localhostOnly middleware already checks the remote IP, Host and Origin.
  if (req.hostname !== RP_ID) return undefined;
  return `http://localhost:${req.socket.localPort}`;
}

export function createAdminPasskeyRouter(options: {
  protect: RequestHandler;
  getSession: (req: Request) => AdminSession | null;
  issueSession: (res: Response, viaToken: boolean) => { csrf: string };
  invalidatePasskeySessions: () => void;
}) {
  const router = Router();
  const storePath = path.resolve(process.env.ADMIN_PASSKEY_FILE ||
    path.join(os.homedir(), ".local", "lcp", "state", "admin-passkeys.json"));
  fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  let store = readStore(storePath);
  let writeQueue = Promise.resolve();
  const enrol = new Map<string, Pending>();
  const login = new Map<string, Pending>();

  async function mutate(fn: (copy: PasskeyFile) => void): Promise<void> {
    const op = writeQueue.then(async () => {
      const next = structuredClone(store);
      fn(next);
      await atomicWriteText(storePath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      store = next;
    });
    writeQueue = op.catch(() => undefined);
    return op;
  }

  function prune(map: Map<string, Pending>): void {
    const now = Date.now();
    for (const [key, item] of map) if (item.expires <= now) map.delete(key);
    while (map.size >= MAX_PENDING) map.delete(map.keys().next().value!);
  }

  function tokenSession(req: Request, res: Response): AdminSession | null {
    const session = options.getSession(req);
    if (!session?.viaToken) {
      res.status(403).json({ ok: false, error: "Admin token login is required to manage passkeys" });
      return null;
    }
    return session;
  }

  function requireLocalhost(req: Request, res: Response): string | undefined {
    const origin = localhostOrigin(req);
    if (!origin) res.status(400).json({
      ok: false, error: "Passkeys require http://localhost (not 127.0.0.1)",
    });
    return origin;
  }

  router.get("/status", (_req, res) => {
    res.json({ ok: true, registered: store.credentials.length > 0 });
  });

  router.post("/registration/options", options.protect, async (req, res) => {
    if (!requireLocalhost(req, res)) return;
    const session = tokenSession(req, res);
    if (!session) return;
    if (store.credentials.length >= MAX_PASSKEYS) {
      res.status(409).json({ ok: false, error: "Maximum registered passkeys reached" });
      return;
    }
    const opts = await generateRegistrationOptions({
      rpName: "Local ChatGPT Plus Admin",
      rpID: RP_ID,
      userName: "Local Admin",
      userDisplayName: "Local Admin",
      userID: Buffer.from(store.userID, "base64url"),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      supportedAlgorithmIDs: [-7, -257],
      excludeCredentials: store.credentials.map(({ id, transports }) => ({ id, transports })),
    });
    prune(enrol);
    enrol.set(session.id, { challenge: opts.challenge, expires: Date.now() + CHALLENGE_MS });
    res.json({ ok: true, options: opts });
  });

  router.post("/registration/verify", options.protect, async (req, res) => {
    const origin = requireLocalhost(req, res);
    if (!origin) return;
    const session = tokenSession(req, res);
    if (!session) return;
    const pending = enrol.get(session.id);
    enrol.delete(session.id); // One attempt per challenge, including invalid assertions.
    if (!pending || pending.expires <= Date.now()) {
      res.status(400).json({ ok: false, error: "Passkey registration challenge expired" });
      return;
    }
    try {
      const verified = await verifyRegistrationResponse({
        response: req.body as RegistrationResponseJSON,
        expectedChallenge: pending.challenge,
        expectedOrigin: origin,
        expectedRPID: RP_ID,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257],
      });
      if (!verified.verified || !verified.registrationInfo) throw new Error("Verification failed");
      const credential = verified.registrationInfo.credential;
      await mutate((copy) => {
        if (copy.credentials.length >= MAX_PASSKEYS || copy.credentials.some((c) => c.id === credential.id)) {
          throw new Error("Credential already registered");
        }
        copy.credentials.push({
          id: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          counter: credential.counter,
          transports: credential.transports,
          createdAt: new Date().toISOString(),
        });
      });
      res.json({ ok: true, registered: true });
    } catch {
      res.status(400).json({ ok: false, error: "Passkey registration could not be verified" });
    }
  });

  router.post("/authentication/options", async (req, res) => {
    if (!requireLocalhost(req, res)) return;
    if (!store.credentials.length) {
      res.status(404).json({ ok: false, error: "No passkey registered. Sign in with your Admin token first." });
      return;
    }
    const authOptions = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "required",
      allowCredentials: store.credentials.map(({ id, transports }) => ({ id, transports })),
    });
    prune(login);
    const id = randomBytes(32).toString("hex");
    login.set(id, { challenge: authOptions.challenge, expires: Date.now() + CHALLENGE_MS });
    res.setHeader("Set-Cookie", `${CHALLENGE_COOKIE}=${id}; Path=/api/auth/passkeys; HttpOnly; SameSite=Strict; Max-Age=120`);
    res.json({ ok: true, options: authOptions });
  });

  router.post("/authentication/verify", async (req, res) => {
    const origin = requireLocalhost(req, res);
    if (!origin) return;
    const id = readCookie(req, CHALLENGE_COOKIE);
    const pending = id ? login.get(id) : undefined;
    if (id) login.delete(id); // Never allow replay of the challenge.
    res.setHeader("Set-Cookie", `${CHALLENGE_COOKIE}=; Path=/api/auth/passkeys; HttpOnly; SameSite=Strict; Max-Age=0`);
    if (!pending || pending.expires <= Date.now()) {
      res.status(400).json({ ok: false, error: "Passkey login challenge expired" });
      return;
    }
    const response = req.body as AuthenticationResponseJSON;
    if (typeof response?.id !== "string" || response.id.length > 2048) {
      res.status(400).json({ ok: false, error: "Invalid passkey response" });
      return;
    }
    const stored = store.credentials.find((item) => item.id === response.id);
    if (!stored) {
      res.status(401).json({ ok: false, error: "Passkey not recognized" });
      return;
    }
    try {
      const verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: origin,
        expectedRPID: RP_ID,
        requireUserVerification: true,
        credential: {
          id: stored.id,
          publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64url")),
          counter: stored.counter,
          transports: stored.transports,
        },
      });
      if (!verified.verified) throw new Error("Verification failed");
      await mutate((copy) => {
        const current = copy.credentials.find((item) => item.id === stored.id);
        if (!current || current.counter !== stored.counter) throw new Error("Concurrent counter update");
        current.counter = verified.authenticationInfo.newCounter;
      });
      const session = options.issueSession(res, false);
      res.json({ ok: true, authenticated: true, csrf: session.csrf });
    } catch {
      res.status(401).json({ ok: false, error: "Passkey authentication failed" });
    }
  });

  router.get("/registered", options.protect, (req, res) => {
    res.json({
      ok: true,
      canManage: Boolean(options.getSession(req)?.viaToken),
      credentials: store.credentials.map((credential) => ({
        id: credential.id, createdAt: credential.createdAt,
      })),
    });
  });

  router.post("/revoke", options.protect, async (req, res) => {
    if (!tokenSession(req, res)) return;
    if (typeof req.body?.id !== "string" || !store.credentials.some((key) => key.id === req.body.id)) {
      res.status(404).json({ ok: false, error: "Passkey not found" });
      return;
    }
    await mutate((copy) => {
      copy.credentials = copy.credentials.filter(({ id }) => id !== req.body.id);
    });
    // Revocation must also revoke already-established passkey browser sessions,
    // not just prevent the next authentication attempt.
    options.invalidatePasskeySessions();
    res.json({ ok: true, remaining: store.credentials.length });
  });

  return router;
}
