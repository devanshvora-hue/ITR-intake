// Password policy and scrypt hashing (ported from ca_auth.py). Stored format:
// "scrypt$N$r$p$<salt>$<hash>" with URL-safe base64 (no padding), so hashes are
// interchangeable with the Python implementation.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const passwordSettings = {
  N: 2 ** 15, // tests lower this to keep the suite fast
  r: 8,
  p: 1,
  keyLength: 32,
  saltBytes: 16,
};
const MAX_MEMORY = 128 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
const COMMON_PASSWORDS = new Set([
  "password1234", "123456789012", "qwertyuiop12", "passwordpassword", "letmein12345", "welcome12345",
  "iloveyou1234", "admin1234567", "changeme1234", "itrintake123",
]);
const HASH_FORMAT = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

export class PasswordPolicyError extends Error {
  constructor(readonly code: "password_invalid" | "password_too_short" | "password_too_long" | "password_too_common") {
    super(code);
    this.name = "PasswordPolicyError";
  }
}

export function checkPasswordPolicy(password: unknown): string {
  if (typeof password !== "string") throw new PasswordPolicyError("password_invalid");
  if (password.length < PASSWORD_MIN_LENGTH) throw new PasswordPolicyError("password_too_short");
  if (password.length > PASSWORD_MAX_LENGTH) throw new PasswordPolicyError("password_too_long");
  if (new Set(password).size < 4 || COMMON_PASSWORDS.has(password.toLowerCase())) {
    throw new PasswordPolicyError("password_too_common");
  }
  return password;
}

function derive(password: string, salt: Buffer, N: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N, r, p, maxmem: MAX_MEMORY }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const { N, r, p, keyLength, saltBytes } = passwordSettings;
  const salt = randomBytes(saltBytes);
  const key = await derive(password, salt, N, r, p, keyLength);
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** [matches, scryptRan]. Never throws. */
async function verify(password: unknown, stored: unknown): Promise<[boolean, boolean]> {
  if (typeof password !== "string" || typeof stored !== "string") return [false, false];
  const m = HASH_FORMAT.exec(stored);
  if (!m) return [false, false];
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (N < 2 || (N & (N - 1)) !== 0 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 16) return [false, false];
  const salt = Buffer.from(m[4], "base64url");
  const expected = Buffer.from(m[5], "base64url");
  if (!salt.length || !expected.length || password.length > PASSWORD_MAX_LENGTH) return [false, false];
  try {
    const actual = await derive(password, salt, N, r, p, expected.length);
    return [timingSafeEqual(actual, expected), true];
  } catch {
    return [false, false];
  }
}

export async function verifyPassword(password: unknown, stored: unknown): Promise<boolean> {
  return (await verify(password, stored))[0];
}

function dummyHash(): string {
  const { N, r, p, keyLength, saltBytes } = passwordSettings;
  return `scrypt$${N}$${r}$${p}$${randomBytes(saltBytes).toString("base64url")}$${Buffer.alloc(keyLength).toString("base64url")}`;
}

/**
 * Verify a login password while always spending one scrypt run, even for an
 * unknown account, a malformed stored hash or a non-string password, so those
 * cases can not be told apart by a fast reply.
 */
export async function checkPassword(password: unknown, stored: unknown | null): Promise<boolean> {
  const [matches, ran] = stored === null ? [false, false] : await verify(password, stored);
  if (!ran) {
    const candidate = typeof password === "string" && password.length <= PASSWORD_MAX_LENGTH ? password : "";
    await verify(candidate, dummyHash());
  }
  return matches;
}
