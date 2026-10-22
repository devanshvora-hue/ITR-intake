// Identifiers, tokens and input normalisation (ported from
// backend/itr_intake_server/ids.py and the token helpers in ca_auth.py).

import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Crockford base32 without I, L, O and U, so references are easy to read aloud.
const REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const REFERENCE_SUFFIX_LENGTH = 6;
const REFERENCE_NAME_MAX = 12;
export const FIRM_CODE_LENGTH = 12; // 60 random bits
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const FINANCIAL_YEAR = /^(\d{4})-(\d{2})$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

export class InvalidId extends Error {
  constructor() {
    super("invalid identifier");
    this.name = "InvalidId";
  }
}

export function newId(): string {
  return randomUUID();
}

/** Returns the value if it is a canonical lower-case UUID4; never creates one. */
export function parseId(value: unknown): string {
  if (typeof value !== "string" || !UUID4.test(value)) throw new InvalidId();
  return value;
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && UUID4.test(value);
}

export function sha256Hex(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A new secret token for a session or one-time link (43 URL-safe characters). */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

export function tokenHash(token: string): string {
  return sha256Hex(token);
}

function randomSymbols(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return out;
}

/** Upper-case ASCII letters of the first name (accents removed), at most 12; "CLIENT" if none. */
export function referenceName(firstName: string): string {
  const ascii = firstName.normalize("NFKD").replace(/[^ -~]/g, "");
  const letters = ascii.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, REFERENCE_NAME_MAX);
  return letters || "CLIENT";
}

/** A human-readable case reference, e.g. "IT-DEVANSH-7K4P92". The database enforces uniqueness. */
export function newCaseReference(firstName: string): string {
  return `IT-${referenceName(firstName)}-${randomSymbols(REFERENCE_SUFFIX_LENGTH)}`;
}

export function isCaseReference(value: unknown): value is string {
  return typeof value === "string" && /^IT-[A-Z]{1,12}-[0-9A-Z]{6}$/.test(value);
}

/** A new random firm code without separators, e.g. "7K4P92XMQR3T". */
export function newFirmCode(): string {
  return randomSymbols(FIRM_CODE_LENGTH);
}

/** Readable form in groups of four: "7K4P-92XM-QR3T". */
export function formatFirmCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

/** Trimmed, lower-case e-mail address; throws if malformed. */
export function normaliseEmail(email: unknown): string {
  if (typeof email !== "string") throw new Error("invalid email");
  const value = email.trim().toLowerCase();
  if (value.length > 254 || !EMAIL.test(value)) throw new Error("invalid email");
  return value;
}

/** "YYYY-YY" where the second year follows the first (e.g. "2025-26"). */
export function validateFinancialYear(value: unknown): string {
  const m = typeof value === "string" ? FINANCIAL_YEAR.exec(value) : null;
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) throw new Error("invalid financial year");
  return value as string;
}
