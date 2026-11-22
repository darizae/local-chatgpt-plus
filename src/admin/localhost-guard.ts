import type { Request, Response, NextFunction } from "express";

function isLocalAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.replace(/^::ffff:/i, "").toLowerCase();
  if (normalized === "127.0.0.1" || normalized === "::1") return true;
  return false;
}

export function localhostOnly(req: Request, res: Response, next: NextFunction): void {
  const remote = req.socket.remoteAddress;
  if (!isLocalAddress(remote)) {
    res.status(403).json({ ok: false, error: "Admin API is localhost-only" });
    return;
  }
  // A loopback TCP peer is not proof of a trustworthy browser origin:
  // DNS rebinding can still deliver untrusted HTTP requests to localhost.
  const host = req.headers.host;
  const port = req.socket.localPort;
  const loopbackNames = new Set(["localhost", "127.0.0.1", "[::1]"]);
  try {
    if (typeof host !== "string" || !host || /[\s\\/@]/.test(host)) throw new Error("Invalid Host");
    const authority = new URL("http://" + host);
    if (!loopbackNames.has(authority.hostname.toLowerCase()) ||
        (authority.port && Number(authority.port) !== port) ||
        authority.username || authority.password || authority.pathname !== "/" ||
        authority.search || authority.hash) throw new Error("Invalid Host");

    if (req.headers.origin !== undefined) {
      const origin = req.headers.origin;
      if (typeof origin !== "string" || origin === "null") throw new Error("Invalid Origin");
      const source = new URL(origin);
      if (source.origin !== origin || source.protocol !== "http:" ||
          !loopbackNames.has(source.hostname.toLowerCase()) ||
          Number(source.port || "80") !== port ||
          source.hostname.toLowerCase() !== authority.hostname.toLowerCase()) {
        throw new Error("Invalid Origin");
      }
    }
    if (req.headers["sec-fetch-site"] === "cross-site") throw new Error("Cross-site request");
  } catch {
    res.status(403).json({ ok: false, error: "Admin requires a same-origin loopback request" });
    return;
  }
  next();
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.ADMIN_TOKEN?.trim();
  if (!token) {
    res.status(503).json({ ok: false, error: "Admin authentication is not configured" });
    return;
  }
  const header = req.headers.authorization;
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : req.headers["x-admin-token"];
  if (provided !== token) {
    res.status(401).json({ ok: false, error: "Invalid admin token" });
    return;
  }
  next();
}