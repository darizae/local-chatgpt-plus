import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { createAdminPasskeyRouter } from "./passkeys.js";

/**
 * Admin authentication is deliberately distinct from MCP OAuth.
 *
 * Token login is local-only; once authenticated the UI receives an HttpOnly,
 * SameSite=Strict cookie plus a separate CSRF secret held in page memory.
 * The bearer header remains available for trusted local automation.
 * No Admin credential appears in a URL, localStorage, or the audit feed.
 */
const COOKIE_NAME = "lcp_admin_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;
const MAX_FAILED_LOGINS = 8;
const FAILURE_WINDOW_MS = 60_000;

type Session = { csrf: string; expires: number; tokenDigest: string; viaToken: boolean };

function hash(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

function equalTokens(a: string, b: string): boolean {
  if (!a || !b || a.length > 4096 || b.length > 4096) return false;
  return timingSafeEqual(hash(a), hash(b));
}

function tokenDigest(token: string): string {
  return hash(token).toString("hex");
}

function parseCookie(req: Request): string | null {
  const raw = req.headers.cookie;
  if (!raw || raw.length > 8192) return null;
  for (const part of raw.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE_NAME && value.length === 1 && /^[a-f0-9]{64}$/.test(value[0])) {
      return value[0];
    }
  }
  return null;
}

const writeMethod = (method: string) => !["GET", "HEAD", "OPTIONS"].includes(method);

export function createAdminSessionAuth() {
  if (!process.env.ADMIN_TOKEN?.trim()) {
    throw new Error("Admin is enabled but ADMIN_TOKEN is empty. Disable Admin or configure a random ADMIN_TOKEN before starting.");
  }

  const sessions = new Map<string, Session>();
  const loginFailures = new Map<string, { attempts: number; resetAt: number }>();
  const router = Router();

  function currentSession(req: Request): (Session & { id: string }) | null {
    const id = parseCookie(req);
    if (!id) return null;
    const session = sessions.get(id);
    if (!session) return null;
    const current = process.env.ADMIN_TOKEN?.trim() ?? "";
    if (session.expires <= Date.now() || session.tokenDigest !== tokenDigest(current)) {
      sessions.delete(id);
      return null;
    }
    return { ...session, id };
  }

  function issueSession(res: Response, viaToken: boolean): { csrf: string } {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.expires <= now) sessions.delete(id);
    }
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    const id = randomBytes(32).toString("hex");
    const csrf = randomBytes(32).toString("hex");
    sessions.set(id, {
      csrf, expires: now + SESSION_TTL_MS,
      tokenDigest: tokenDigest(process.env.ADMIN_TOKEN!.trim()), viaToken,
    });
    const cookie = `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`;
    const existing = res.getHeader("Set-Cookie");
    res.setHeader("Set-Cookie", existing ? [cookie, ...(Array.isArray(existing) ? existing.map(String) : [String(existing)])] : cookie);
    return { csrf };
  }

  const protect: RequestHandler = (req, res, next) => {
    const configured = process.env.ADMIN_TOKEN?.trim() ?? "";
    if (!configured) {
      res.status(503).json({ ok: false, error: "Admin credentials unavailable" });
      return;
    }

    const authorization = req.headers.authorization;
    if (authorization?.startsWith("Bearer ") && equalTokens(configured, authorization.slice(7))) {
      next();
      return;
    }

    const session = currentSession(req);
    if (!session) {
      res.status(401).json({ ok: false, error: "Admin authentication required" });
      return;
    }
    if (writeMethod(req.method)) {
      const supplied = req.headers["x-lcp-admin-csrf"];
      if (typeof supplied !== "string" || !equalTokens(session.csrf, supplied)) {
        res.status(403).json({ ok: false, error: "Missing or invalid Admin CSRF token" });
        return;
      }
    }
    next();
  };

  router.post("/login", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!req.is("application/json") || typeof req.body?.token !== "string") {
      res.status(400).json({ ok: false, error: "JSON token required" });
      return;
    }
    const address = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const record = loginFailures.get(address);
    if (record && record.resetAt > now && record.attempts >= MAX_FAILED_LOGINS) {
      res.status(429).json({ ok: false, error: "Too many failed Admin logins" });
      return;
    }
    if (!equalTokens(process.env.ADMIN_TOKEN?.trim() ?? "", req.body.token)) {
      const count = record && record.resetAt > now ? record.attempts + 1 : 1;
      loginFailures.set(address, { attempts: count, resetAt: now + FAILURE_WINDOW_MS });
      res.status(401).json({ ok: false, error: "Invalid Admin credential" });
      return;
    }
    loginFailures.delete(address);
    const { csrf } = issueSession(res, true);
    res.json({ ok: true, authenticated: true, csrf });
  });

  router.get("/session", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const session = currentSession(req);
    if (!session) {
      res.status(401).json({ ok: false, authenticated: false });
      return;
    }
    res.json({ ok: true, authenticated: true, csrf: session.csrf, viaToken: session.viaToken });
  });

  router.post("/logout", (req, res) => {
    const session = currentSession(req);
    const supplied = req.headers["x-lcp-admin-csrf"];
    if (!session || typeof supplied !== "string" || !equalTokens(session.csrf, supplied)) {
      res.status(403).json({ ok: false, error: "Invalid Admin session" });
      return;
    }
    const id = parseCookie(req);
    if (id) sessions.delete(id);
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  router.use("/passkeys", createAdminPasskeyRouter({
    protect,
    getSession: currentSession,
    issueSession,
    invalidatePasskeySessions: () => {
      for (const [id, session] of sessions) if (!session.viaToken) sessions.delete(id);
    },
  }));

  return { router, protect };
}
