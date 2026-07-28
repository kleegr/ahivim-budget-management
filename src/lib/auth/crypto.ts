import {
  scrypt,
  randomBytes,
  timingSafeEqual,
  createHmac,
  hkdfSync,
} from "node:crypto";

/**
 * AUTHENTICATION PRIMITIVES
 * =========================
 *
 * - Passwords are hashed with scrypt (N=2^15, r=8, p=1) and a random 16-byte
 *   salt. Nothing stores or logs a plaintext password.
 * - Sessions are stateless: an HMAC-SHA256-signed payload in an HttpOnly
 *   cookie with an explicit expiry. Tampering invalidates the signature;
 *   expiry is checked server-side on every read.
 * - The signing key comes from AUTH_SECRET. If AUTH_SECRET is not set, a key
 *   is DERIVED from the database connection string with HKDF-SHA256 and a
 *   fixed application salt. That fallback keeps a fresh deployment usable
 *   without manual configuration, and is documented in docs/authentication.md
 *   with the recommendation to set an explicit secret (rotating the database
 *   password invalidates sessions under the fallback).
 */

const SCRYPT_N = 32768;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) {
    throw new RangeError("Passwords must be at least 10 characters");
  }
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt);
  return ["scrypt", SCRYPT_N, SCRYPT_r, SCRYPT_p, salt.toString("base64"), derived.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const derived = await scryptAsync(password, salt, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      length: expected.length,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function scryptAsync(
  password: string,
  salt: Buffer,
  opts: { N?: number; r?: number; p?: number; length?: number } = {},
): Promise<Buffer> {
  const { N = SCRYPT_N, r = SCRYPT_r, p = SCRYPT_p, length = KEY_LENGTH } = opts;
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, { N, r, p, maxmem: 128 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key as Buffer),
    );
  });
}

/** Generate a URL-safe random password for the bootstrap administrator. */
export function generatePassword(bytes = 18): string {
  return randomBytes(bytes).toString("base64url");
}

/* -------------------------------------------------------------------------- */
/* Session signing                                                             */
/* -------------------------------------------------------------------------- */

let cachedKey: Buffer | null = null;

/** The session signing key. AUTH_SECRET, or HKDF(DATABASE_URL) as a fallback. */
export function sessionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const explicit = process.env.AUTH_SECRET?.trim();
  if (explicit) {
    cachedKey = createHmac("sha256", "ahivim-auth-v1").update(explicit).digest();
    return cachedKey;
  }
  const candidates = [
    process.env.DATABASE_URL,
    process.env.POSTGRES_URL,
    process.env.DATABASE_URL_UNPOOLED,
    process.env.POSTGRES_URL_NON_POOLING,
    process.env.POSTGRES_PRISMA_URL,
    process.env.NEON_DATABASE_URL,
  ];
  const source = candidates.find((v) => v && v.trim() !== "");
  if (!source) {
    throw new Error("Cannot derive a session key: no AUTH_SECRET and no database URL.");
  }
  cachedKey = Buffer.from(
    hkdfSync("sha256", source, "ahivim-session-salt-v1", "session-signing", 32),
  );
  return cachedKey;
}

export interface SessionPayload {
  userId: string;
  role: string;
  displayName: string;
  /** Unix ms expiry. */
  exp: number;
}

export function signSession(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", sessionKey()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function readSession(token: string | undefined | null): SessionPayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", sessionKey()).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    if (!payload.userId || !payload.role) return null;
    return payload;
  } catch {
    return null;
  }
}
