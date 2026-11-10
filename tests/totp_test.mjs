// totp.js on its own: the maths, the secret encryption, the recovery codes and the wrong-code lock.
// Nothing to start: no server, no database. Run from the repo root:
//   node tests/totp_test.mjs
//
// The TOTP and HOTP values are the published ones (RFC 6238 appendix B, RFC 4226 appendix D), so a pass here means
// the codes match what Aegis, Google Authenticator and every other app compute for the same secret.
//
// Does NOT prove: that a real authenticator app scans the QR code (see tests/twofa_test.mjs for the address it
// carries), or how any of it looks.

import { createRequire } from "node:module";
import path from "node:path";
import crypto from "node:crypto";

const require = createRequire(path.join(process.cwd(), "package.json"));
const totp = require("./totp.js");

let passed = 0, failed = 0;
function check(name, cond, extra = "") { if (cond) passed++; else { failed++; console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`); } }
function throws(fn) { try { fn(); return false; } catch { return true; } }

// ---- base32 (RFC 4648 section 10 test vectors)
{
  const vec = [["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]];
  check("base32 encode: the RFC 4648 vectors (without = padding)", vec.every(([plain, enc]) => totp.base32Encode(Buffer.from(plain)) === enc));
  check("base32 decode: the same vectors back", vec.every(([plain, enc]) => totp.base32Decode(enc).toString() === plain));
  check("base32 decode: lower case and = padding are accepted (apps and people type them)", totp.base32Decode("mzxw6ytb").toString() === "fooba" && totp.base32Decode("MZXW6===").toString() === "foo");
  check("base32 decode: a character outside the alphabet is refused", throws(() => totp.base32Decode("MZXW1")));
  const bytes = crypto.randomBytes(20);
  check("base32: 20 random bytes survive the round trip", totp.base32Decode(totp.base32Encode(bytes)).equals(bytes));
}

// ---- HOTP (RFC 4226 appendix D): secret "12345678901234567890", 6 digits, counters 0..9
{
  const key = Buffer.from("12345678901234567890");
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  check("HOTP: the ten RFC 4226 values", expected.every((code, counter) => totp.hotp(key, counter) === code), expected.map((_, c) => totp.hotp(key, c)).join(","));
}

// ---- TOTP (RFC 6238 appendix B), SHA-1, 8 digits. The secret is the same ASCII string.
{
  const secret = totp.base32Encode(Buffer.from("12345678901234567890"));
  const vec = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]];
  check("TOTP: the six RFC 6238 SHA-1 values (8 digits)", vec.every(([t, code]) => totp.codeAt(secret, t * 1000, 8) === code), vec.map(([t]) => totp.codeAt(secret, t * 1000, 8)).join(","));
  check("TOTP: the 6 digits an app shows are the last six of those (and keep a leading zero)", totp.codeAt(secret, 1111111109 * 1000) === "081804" && totp.codeAt(secret, 59 * 1000) === "287082");
  check("TOTP: a step lasts 30 seconds (the code changes at :30, not before)", totp.codeAt(secret, 29999) === totp.codeAt(secret, 0) && totp.codeAt(secret, 30000) !== totp.codeAt(secret, 29999));
}

// ---- checking a typed code (time is moved by replacing totp.clock.now)
{
  const secret = totp.generateSecret();
  const T0 = 1_700_000_000_000 - (1_700_000_000_000 % 30000); // the start of a step
  const step = T0 / 30000;
  totp.clock.now = () => T0 + 10_000;
  const at = (offsetSteps) => totp.codeAt(secret, T0 + offsetSteps * 30000);
  check("verify: the current code is accepted, and the answer is its step", totp.verify(secret, at(0)) === step);
  check("verify: one step old and one step ahead are accepted (clock drift), with their own steps", totp.verify(secret, at(-1)) === step - 1 && totp.verify(secret, at(1)) === step + 1);
  check("verify: two steps old or ahead are refused", totp.verify(secret, at(-2)) === null && totp.verify(secret, at(2)) === null);
  check("verify: spaces inside are ignored (\"123 456\")", totp.verify(secret, at(0).slice(0, 3) + " " + at(0).slice(3)) === step);
  check("verify: a wrong code, short, long, empty, letters and a number are all refused", ["000000", "12345", "1234567", "", "abcdef", "12345a", " "].every((c) => totp.verify(secret, c) === null) && totp.verify(secret, 123456) === (at(0) === "123456" ? step : null));
  check("verify: a code made from another secret is refused", totp.verify(totp.generateSecret(), at(0)) === null);
  totp.clock.now = () => Date.now();
}

// ---- secrets and the address the QR code carries
{
  const s = totp.generateSecret();
  check("generateSecret: 32 base32 characters (20 bytes), different each time", /^[A-Z2-7]{32}$/.test(s) && s !== totp.generateSecret());
  const uri = totp.otpauthUri("JBSWY3DPEHPK3PXP", "chu.shop");
  check("otpauth address: Bloomy:<user>, the secret and the issuer — the form Aegis reads", uri === "otpauth://totp/Bloomy:chu.shop?secret=JBSWY3DPEHPK3PXP&issuer=Bloomy", uri);
}

// ---- encryption of the secret at rest
{
  const saved = process.env.TOTP_ENCRYPTION_KEY;
  try {
    delete process.env.TOTP_ENCRYPTION_KEY;
    check("no key set: encrypting is refused with a message that says what to do", throws(() => totp.encryptSecret("ABC")) && (() => { try { totp.loadKey(); } catch (e) { return /openssl rand -base64 32/.test(e.message); } })());
    process.env.TOTP_ENCRYPTION_KEY = crypto.randomBytes(16).toString("base64");
    check("a key of the wrong length (16 bytes) is refused", throws(() => totp.loadKey()));
    process.env.TOTP_ENCRYPTION_KEY = "not base64 at all !!!";
    check("a key that is not base64 is refused", throws(() => totp.loadKey()));
    const key = crypto.randomBytes(32).toString("base64");
    process.env.TOTP_ENCRYPTION_KEY = key;
    const secret = totp.generateSecret();
    const stored = totp.encryptSecret(secret);
    check("encrypt → decrypt gives the secret back", totp.decryptSecret(stored) === secret);
    check("the stored text does not contain the secret, in plain or as base64 of it", !stored.includes(secret) && !Buffer.from(stored, "base64").toString("latin1").includes(secret));
    check("stored form is base64 of 12-byte IV + ciphertext + 16-byte tag (12 + 32 + 16 = 60 bytes)", Buffer.from(stored, "base64").length === 60);
    check("encrypting the same secret twice gives different text (fresh IV each time)", totp.encryptSecret(secret) !== stored);
    const tampered = Buffer.from(stored, "base64"); tampered[20] ^= 1;
    check("a changed byte makes decryption fail (GCM checks it, no garbage comes back)", throws(() => totp.decryptSecret(tampered.toString("base64"))));
    check("a truncated value fails", throws(() => totp.decryptSecret(stored.slice(0, 20))));
    process.env.TOTP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    check("another key cannot read it", throws(() => totp.decryptSecret(stored)));
  } finally {
    if (saved === undefined) delete process.env.TOTP_ENCRYPTION_KEY; else process.env.TOTP_ENCRYPTION_KEY = saved;
  }
}

// ---- recovery codes
{
  const codes = totp.generateRecoveryCodes();
  check("ten recovery codes, each XXXXX-XXXXX from the alphabet without 0 O 1 I L", codes.length === 10 && codes.every((c) => /^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/.test(c)), codes.join(" "));
  check("…all different", new Set(codes).size === 10);
  check("normalising: dashes, spaces and lower case are ignored", totp.normalizeRecoveryCode(" abcde-fghjk ") === "ABCDEFGHJK" && totp.normalizeRecoveryCode("abcde fghjk") === "ABCDEFGHJK");
  check("a recovery code never looks like a 6-digit app code (so the two are told apart by format)", codes.every((c) => !/^\d{6}$/.test(totp.normalizeRecoveryCode(c))));
  const big = totp.generateRecoveryCodes(2000).map(totp.normalizeRecoveryCode).join("");
  const counts = {}; for (const ch of big) counts[ch] = (counts[ch] || 0) + 1;
  const alphabetSize = Object.keys(counts).length;
  const mean = big.length / alphabetSize;
  check("the alphabet has 31 characters and every one is used about equally (no modulo bias)", alphabetSize === 31 && Object.values(counts).every((n) => n > mean * 0.8 && n < mean * 1.2), `size ${alphabetSize}`);
}

// ---- the wrong-code lock (3 tries, then 5 minutes), time moved by hand
{
  let now = 1_000_000;
  totp.clock.now = () => now;
  const lock = totp.createAttemptLock(3, 5 * 60 * 1000);
  const wrong = (k) => { const b = lock.begin(k); if (b.ok) lock.fail(k); return b; };
  check("lock: three wrong tries are all allowed", wrong(1).ok && wrong(1).ok && wrong(1).ok);
  const fourth = lock.begin(1);
  check("…the fourth is refused, with the time left (300 seconds)", fourth.ok === false && fourth.secondsLeft === 300, JSON.stringify(fourth));
  now += 299_000;
  check("…still refused 299 seconds later, 1 second left", lock.begin(1).ok === false && lock.begin(1).secondsLeft === 1);
  now += 1_000;
  check("…allowed again at 300 seconds, and the count starts again from zero (three more tries)", wrong(1).ok && wrong(1).ok && wrong(1).ok && lock.begin(1).ok === false);
  check("another account is not affected", lock.begin(2).ok === true);

  const lock2 = totp.createAttemptLock(3, 5 * 60 * 1000);
  lock2.begin("a"); lock2.fail("a"); lock2.begin("a"); lock2.fail("a");
  lock2.begin("a"); lock2.succeed("a");
  check("lock: a right code gives the tries back (two wrong, one right, then three more are allowed)", wrong2(lock2) && wrong2(lock2) && wrong2(lock2));
  function wrong2(l) { const b = l.begin("a"); if (b.ok) l.fail("a"); return b.ok; }

  const lock3 = totp.createAttemptLock(3, 5 * 60 * 1000);
  const burst = Array.from({ length: 100 }, () => lock3.begin("x").ok);
  check("lock: a hundred tries started at once (before any answer) let only three through", burst.filter(Boolean).length === 3, String(burst.filter(Boolean).length));
  check("…and the account is locked at once", lock3.begin("x").ok === false);
  const lock4 = totp.createAttemptLock(3, 5 * 60 * 1000);
  lock4.begin("y"); lock4.fail("y"); lock4.begin("y"); lock4.fail("y");
  lock4.begin("y");
  const third = lock4.fail("y");
  check("lock: the third wrong try itself reports the lock (so the page can say so straight away)", third.locked === true && third.secondsLeft === 300, JSON.stringify(third));
  totp.clock.now = () => Date.now();
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
