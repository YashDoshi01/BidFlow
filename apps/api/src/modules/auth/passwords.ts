import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt is memory-hard, which makes GPU/ASIC guessing expensive, and ships
// with Node (no native dependency to install). Parameters are stored inside
// the hash string so they can be raised later without invalidating old hashes.
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const options: ScryptOptions = { N: n, r, p, maxmem: 128 * n * r * 2 };
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Format: scrypt$N$r$p$saltBase64$hashBase64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${String(N)}$${String(R)}$${String(P)}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || n > 1 << 20) return false;
  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, Buffer.from(saltB64, 'base64'), n, r, p);
  // Constant-time comparison: == on strings leaks how many leading bytes matched.
  return timingSafeEqual(actual, expected);
}
