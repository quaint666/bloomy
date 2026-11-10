// Bloomy — two-factor authentication helpers (TOTP, RFC 6238) for the owner account.
// Lives at the repo root next to pricing.js and seo.js; used by routes/admin-auth.js.
//
// What is in here, in the order it is used:
//   1. TOTP itself: a random secret, the 6-digit code for a moment in time, and checking a typed code.
//      The settings are the RFC defaults every authenticator app (Aegis, Google Authenticator, ...)
//      expects: HMAC-SHA-1, 6 digits, 30-second steps. Do not change them: the app would show codes
//      the server never accepts.
//   2. Encrypting the secret before it goes into the database (AES-256-GCM, key from TOTP_ENCRYPTION_KEY).
//      The key lives in the environment, the secret in the database: reading a database dump or a
//      backup alone does not give anyone the means to make valid codes.
//   3. Recovery codes: ten one-time codes for the day the phone is lost. Only their bcrypt hashes are
//      stored (admin-auth.js does the hashing, with the same helper as passwords).
//
// No dependencies beyond Node's crypto.
import crypto from "crypto";

const PERIOD_SECONDS = 30;
const DIGITS = 6;
// A typed code counts if it belongs to the current step or one step either side, because the phone's
// clock and the server's are never exactly the same (and a code typed at second 29 is checked at second 31).
const ALLOWED_DRIFT_STEPS = 1;
const ISSUER = "Bloomy";

// Tests replace clock.now to move time; nothing else should.
const clock = { now: (): number => Date.now() };

// ---------------------------------------------------------------------------
// Base32 (RFC 4648, the alphabet authenticator apps use for secrets)
// ---------------------------------------------------------------------------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of String(str).toUpperCase().replace(/=+$/, "")) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("not base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

// 20 random bytes (the length RFC 4226 recommends for SHA-1) as a 32-character base32 string.
function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

// HOTP (RFC 4226): the code for one counter value. `digits` is a parameter only so the RFC's own
// 8-digit test vectors can be checked; the app always uses DIGITS.
function hotp(key: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = h[h.length - 1] & 15;
  const bin = ((h[offset] & 127) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

function stepAt(timeMs: number): number {
  return Math.floor(timeMs / 1000 / PERIOD_SECONDS);
}

// The code a phone would show at `timeMs` (default: now). Used by tests and nothing else.
function codeAt(secretBase32: string, timeMs = clock.now(), digits = DIGITS): string {
  return hotp(base32Decode(secretBase32), stepAt(timeMs), digits);
}

// Is `input` a valid code right now? Returns the step it belongs to, or null. The caller stores that
// step and refuses anything at or below it afterwards, so a code works once (see admin-auth.js).
// Spaces are ignored ("123 456"); anything that is not exactly 6 digits is simply not a code.
function verify(secretBase32: string, input: unknown): number | null {
  const typed = String(input).replace(/\s+/g, "");
  if (!/^\d{6}$/.test(typed)) return null;
  const key = base32Decode(secretBase32);
  const now = stepAt(clock.now());
  const typedBuf = Buffer.from(typed);
  let matched: number | null = null;
  // Every candidate is checked (no early exit) so the time taken does not depend on which one matched.
  for (let step = now - ALLOWED_DRIFT_STEPS; step <= now + ALLOWED_DRIFT_STEPS; step++) {
    const expected = Buffer.from(hotp(key, step));
    if (crypto.timingSafeEqual(expected, typedBuf)) matched = step;
  }
  return matched;
}

// The address the QR code carries (the "Key URI format" every authenticator app reads).
function otpauthUri(secretBase32: string, username: string): string {
  // The colon between issuer and account is literal (the Key URI format); each part is encoded on its own.
  const label = `${encodeURIComponent(ISSUER)}:${encodeURIComponent(username)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(ISSUER)}`;
}

// ---------------------------------------------------------------------------
// Encrypting the secret at rest: AES-256-GCM
// ---------------------------------------------------------------------------
// TOTP_ENCRYPTION_KEY = 32 random bytes, base64 (make one with: openssl rand -base64 32).
// Stored form (one text column): base64( 12-byte IV | ciphertext | 16-byte auth tag ).
// GCM also authenticates, so a damaged or swapped value fails to decrypt instead of giving garbage.
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function loadKey(): Buffer {
  const raw = process.env.TOTP_ENCRYPTION_KEY || "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("TOTP_ENCRYPTION_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32)");
  }
  return key;
}

function encryptSecret(secretBase32: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", loadKey(), iv);
  const ct = Buffer.concat([cipher.update(secretBase32, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64");
}

function decryptSecret(stored: string): string {
  const buf = Buffer.from(String(stored), "base64");
  if (buf.length < IV_BYTES + TAG_BYTES + 1) throw new Error("stored 2FA secret is too short");
  const decipher = crypto.createDecipheriv("aes-256-gcm", loadKey(), buf.subarray(0, IV_BYTES));
  decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
  return Buffer.concat([decipher.update(buf.subarray(IV_BYTES, buf.length - TAG_BYTES)), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------
// Ten characters from an alphabet without the look-alikes (no 0/O, 1/I/L), shown as XXXXX-XXXXX:
// 31^10 is about 2^49 possibilities, and a wrong guess is also stopped by the 3-strikes lock.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const RECOVERY_COUNT = 10;
const RECOVERY_LENGTH = 10;

function generateRecoveryCodes(count = RECOVERY_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let code = "";
    for (let j = 0; j < RECOVERY_LENGTH; j++) code += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return codes;
}

// What a person typed -> the form that was hashed: no dashes or spaces, upper case.
function normalizeRecoveryCode(input: unknown): string {
  return String(input).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Wrong-code lock: 3 wrong codes -> locked for 5 minutes
// ---------------------------------------------------------------------------
// Kept in memory, per account (the key is whatever the caller passes, here the admin id), so a restart of
// the server clears every lock: acceptable for one small shop, and said so rather than hidden.
//
// Each try is COUNTED BEFORE it is checked (begin), not after. Counting after would let someone fire a
// hundred guesses at once: all of them would pass the "not locked yet" test before any had failed.
//   begin(key)   -> { ok: true }, or { ok: false, secondsLeft } while locked. Use up one of the tries.
//   fail(key)    -> the try was wrong: if no tries are left, start the lock.
//   succeed(key) -> the try was right: tries are back to full (a lock that already started stays).
type LockKey = string | number;
interface LockEntry { tries: number; until: number }

function createAttemptLock(maxTries: number, lockMs: number) {
  const state = new Map<LockKey, LockEntry>(); // key -> { tries, until }
  const secondsLeft = (until: number) => Math.max(1, Math.ceil((until - clock.now()) / 1000));
  const locked = (e: LockEntry | undefined) => e && e.until > clock.now();
  return {
    begin(key: LockKey): { ok: true } | { ok: false; secondsLeft: number } {
      let e = state.get(key);
      if (e && e.until && !locked(e)) { state.delete(key); e = undefined; } // the lock ran out: start fresh
      if (locked(e)) return { ok: false, secondsLeft: secondsLeft(e!.until) };
      if (!e) { e = { tries: 0, until: 0 }; state.set(key, e); }
      if (e.tries >= maxTries) { // every try is used or in flight: lock now
        e.until = clock.now() + lockMs;
        return { ok: false, secondsLeft: secondsLeft(e.until) };
      }
      e.tries++;
      return { ok: true };
    },
    fail(key: LockKey): { locked: true; secondsLeft: number } | { locked: false } {
      const e = state.get(key);
      if (e && e.tries >= maxTries && !locked(e)) e.until = clock.now() + lockMs;
      return e && locked(e) ? { locked: true, secondsLeft: secondsLeft(e.until) } : { locked: false };
    },
    succeed(key: LockKey): void {
      const e = state.get(key);
      if (!e) return;
      if (locked(e)) e.tries = 0;
      else state.delete(key);
    },
  };
}

export {
  PERIOD_SECONDS,
  DIGITS,
  ISSUER,
  RECOVERY_COUNT,
  clock,
  base32Encode,
  base32Decode,
  generateSecret,
  hotp,
  codeAt,
  verify,
  otpauthUri,
  loadKey,
  encryptSecret,
  decryptSecret,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  createAttemptLock,
};
