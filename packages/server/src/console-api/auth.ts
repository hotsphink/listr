/**
 * Operator login for the console: one password, stored as a scrypt hash in the
 * variant's config file, traded at login for an in-memory session cookie.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;
const PREFIX = "scrypt$";

export const SESSION_COOKIE = "listr_console";
const DEFAULT_IDLE_HOURS = 12;
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;

// Global, not per IP: behind Funnel or a reverse proxy every request comes
// from the proxy's address.
const FREE_FAILURES = 5;
const LOCKOUT_MS = 30_000;

/** `scrypt$N=16384,r=8,p=1$<salt>$<hash>`, both base64url. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN, SCRYPT);
  return `${PREFIX}N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/** False for a wrong password or a malformed hash. Never throws. */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    if (!stored.startsWith(PREFIX)) return false;
    const [params, saltB64, hashB64] = stored.slice(PREFIX.length).split("$");
    const p = Object.fromEntries(params.split(",").map((kv) => kv.split("=")).map(([k, v]) => [k, Number(v)]));
    if (!p.N || !p.r || !p.p) return false;
    const expected = Buffer.from(hashB64, "base64url");
    const actual = scryptSync(password, Buffer.from(saltB64, "base64url"), expected.length, {
      N: p.N, r: p.r, p: p.p, maxmem: 256 * p.N * p.r,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

interface Session {
  createdAt: number;
  lastUsed: number;
}

export class ConsoleAuth {
  private sessions = new Map<string, Session>();
  private failures = 0;
  private lastFailure = 0;
  private idleMs: number;

  constructor(
    private passwordHash: string,
    opts: { idleHours?: number; now?: () => number } = {},
  ) {
    this.idleMs = (opts.idleHours ?? DEFAULT_IDLE_HOURS) * 60 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  private now: () => number;

  /** A session id, or how long to wait before trying again. */
  login(password: string): { ok: true; sessionId: string } | { ok: false; retryAfterMs: number | null } {
    const now = this.now();
    if (this.failures >= FREE_FAILURES) {
      const wait = this.lastFailure + LOCKOUT_MS - now;
      if (wait > 0) return { ok: false, retryAfterMs: wait };
    }
    if (!verifyPassword(password, this.passwordHash)) {
      this.failures++;
      this.lastFailure = now;
      return { ok: false, retryAfterMs: null };
    }
    this.failures = 0;
    const sessionId = randomBytes(32).toString("base64url");
    this.sessions.set(sessionId, { createdAt: now, lastUsed: now });
    return { ok: true, sessionId };
  }

  logout(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Check a session and refresh its idle timer. */
  check(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const now = this.now();
    if (now - s.lastUsed > this.idleMs || now - s.createdAt > ABSOLUTE_MS) {
      this.sessions.delete(sessionId);
      return false;
    }
    s.lastUsed = now;
    return true;
  }
}
