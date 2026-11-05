// Email + password accounts for coaches and clients. Passwords are scrypt-hashed; session tokens are
// random and stored only as SHA-256 hashes.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { q } from "./db.ts";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SESSION_DAYS = 90;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export type Role = "coach" | "client";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();
export const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(pw, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export async function createSession(role: Role, userId: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await q(`INSERT INTO sessions (token_hash, role, user_id, expires_at) VALUES ($1, $2, $3, $4)`,
    [sha256(token), role, userId, expires]);
  return token;
}

export function bearer(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return token.length > 0 && token.length <= 200 ? token : "";
}

/** The signed-in user id for a role, or null. Extends the session on every use. */
export async function sessionUser(req: Request, role: Role): Promise<number | null> {
  const token = bearer(req);
  if (!token) return null;
  const hash = sha256(token);
  const [s] = await q(`SELECT user_id, expires_at FROM sessions WHERE token_hash = $1 AND role = $2`, [hash, role]);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    await q(`DELETE FROM sessions WHERE token_hash = $1`, [hash]);
    return null;
  }
  await q(`UPDATE sessions SET expires_at = $2 WHERE token_hash = $1`, [hash, new Date(Date.now() + SESSION_DAYS * 864e5)]);
  return s.user_id;
}

export async function endSession(req: Request) {
  const token = bearer(req);
  if (token) await q(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
}

/**
 * Checks a password against a coaches/clients row with a short lockout after repeated failures.
 * Returns an error message, or null when the password is right.
 */
export async function verifyLogin(table: "coaches" | "clients", row: any, password: string): Promise<string | null> {
  const generic = "That email and password don't match.";
  if (!row) { await hashPassword(password); return generic; }   // same timing as a real check
  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    return "Too many tries. Wait 15 minutes and try again.";
  }
  if (!(await checkPassword(password, row.password_hash))) {
    const failed = row.failed_logins + 1;
    const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
    await q(`UPDATE ${table} SET failed_logins = $2, locked_until = $3 WHERE id = $1`,
      [row.id, lock ? 0 : failed, lock]);
    return generic;
  }
  if (row.failed_logins || row.locked_until) {
    await q(`UPDATE ${table} SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [row.id]);
  }
  return null;
}
