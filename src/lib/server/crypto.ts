/**
 * Password hashing, token derivation and symmetric encryption.
 *
 * Choices, and why:
 *
 *  * Passwords: scrypt from Node's built-in `crypto`. It is memory-hard, it is
 *    in the standard library, and it has no native build step -- so the project
 *    installs and tests identically on Windows, macOS, Linux and in CI. Argon2id
 *    is the better primitive but pulls a prebuilt binary per platform, which is a
 *    real reliability cost for a marginal gain at this scale. Every hash is
 *    peppered with AUTH_PEPPER, so a database dump alone cannot be attacked
 *    offline.
 *
 *  * Opaque tokens (refresh tokens, console tokens, device secrets) are random
 *    32-byte values. We store only sha256, so the database never holds a
 *    credential that can be replayed.
 *
 *  * TOTP secrets are encrypted with AES-256-GCM under AUTH_SECRET rather than
 *    stored raw, so a read-only database leak does not hand an attacker a
 *    working second factor.
 */
import {
  randomBytes,
  scrypt as scryptCallback,
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { env } from "./env";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt needs roughly 128 * N * r bytes. Node's default 32 MB cap is enough for
 * N=16384,r=8 but not for higher cost settings, so scale the limit with N
 * instead of letting the call fail with a confusing allocation error.
 */
function maxmemFor(cost: number): number {
  return 256 * cost * 8;
}

/**
 * Hash a password. Output format is self-describing so the cost can be raised
 * later without invalidating existing hashes:
 *   scrypt$N$r$p$<salt-b64>$<hash-b64>
 */
export async function hashPassword(password: string): Promise<string> {
  const cost = env.scryptCost;
  const salt = randomBytes(16);
  const derived = await scrypt(`${password}${env.authPepper}`, salt, 64, {
    N: cost,
    r: 8,
    p: 1,
    maxmem: maxmemFor(cost),
  });
  return `scrypt$${cost}$8$1$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * Verify a password against a stored hash. Returns false rather than throwing on
 * a malformed or truncated hash: a corrupt row must fail the login, not the
 * request.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const cost = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(cost) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(`${password}${env.authPepper}`, salt, expected.length, {
      N: cost,
      r,
      p,
      maxmem: maxmemFor(cost),
    });
  } catch {
    return false;
  }
  return constantTimeEqual(derived, expected);
}

/** Timing-safe comparison that tolerates length mismatch without throwing. */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    // timingSafeEqual throws on length mismatch, so compare a same-length
    // dummy to keep the work constant, then report the difference.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** A 32-byte URL-safe opaque token. Returned to the client, stored as a hash. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * A user-facing code in an unambiguous alphabet.
 *
 * The old 6-character session id used 32 symbols, which sounds like 30 bits but
 * is only 30 bits if every symbol is uniformly used. More importantly it was
 * short enough to be worth brute-forcing against an unauthenticated read
 * endpoint. Callers needing a *public* handle use 22 chars (128 bits).
 *
 * Excludes I, O, 0, 1 and similar so a code can be read aloud over a ward
 * phone line without ambiguity.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateCode(length = 22): string {
  // Rejection sampling: `bytes % 32` is biased toward the first 9 letters of a
  // 36-symbol alphabet, which quietly removes entropy. Drawing from a 32-symbol
  // alphabet with 5 bits per draw is exact.
  const out: string[] = [];
  while (out.length < length) {
    const chunk = randomBytes(length * 2);
    for (const byte of chunk) {
      if (out.length === length) break;
      // Discard anything >= 256 - (256 % 32) so every value maps 1:1.
      if (byte >= 256 - (256 % CODE_ALPHABET.length)) continue;
      out.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]);
    }
  }
  return out.join("");
}

/** sha256 hex of a token, for at-rest storage. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Hash a one-time passcode, bound to both the code and its purpose.
 * Binding the purpose means a code emailed for "login" cannot be replayed
 * against "pin_reset" even if the same 6 digits are chosen again.
 */
export function hashOtpCode(code: string, purpose: string, email: string): string {
  return createHash("sha256")
    .update(`${code}:${purpose}:${email.toLowerCase()}:${env.authPepper}`)
    .digest("hex");
}

/** Constant-time string comparison for hex digests of equal expected length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return constantTimeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** HMAC-SHA256 over a canonical string, used for audit-chain hashing. */
export function hmacHex(value: string): string {
  return createHmac("sha256", env.authSecret).update(value).digest("hex");
}

// --- AES-256-GCM for TOTP secrets -----------------------------------------

function encryptionKey(): Buffer {
  // Derive a fixed-length key from the configured secret via HKDF-like stretching
  // so a secret of any length yields exactly 32 bytes.
  return createHash("sha256").update(`${env.authSecret}:totp`).digest();
}

/** Encrypt a TOTP secret at rest. Output is nonce||ciphertext||tag. */
export function encryptSecret(plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, enc, cipher.getAuthTag()]);
}

/** Decrypt a stored TOTP secret. Returns null if the ciphertext was tampered with. */
export function decryptSecret(payload: Buffer): string | null {
  if (payload.length < 12 + 16 + 1) return null;
  try {
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(payload.length - 16);
    const data = payload.subarray(12, payload.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    // A GCM tag mismatch means the row was altered. Fail closed.
    return null;
  }
}
