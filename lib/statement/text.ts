// Narration helpers (port of backend/itr_intake/text.py): normalisation, mode
// detection, counterparty extraction and person-name matching. They read
// narrations; they never change them.

export type TransactionMode =
  | "UPI" | "NEFT" | "RTGS" | "IMPS" | "ACH/NACH" | "ATM" | "Cheque" | "Cash" | "Card" | "Bank internal" | "Other";

const TITLES = new Set(["MR", "MRS", "MS", "MISS", "DR", "SHRI", "SMT", "KUM"]);

/** Upper-case, punctuation as single spaces. '@' is kept for UPI IDs. */
export function normalise(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9@]+/g, " ").trim();
}

export function tokens(text: string): string[] {
  return normalise(text).replace(/@/g, " ").split(" ").filter(Boolean);
}

const MODE_PATTERNS: [RegExp, TransactionMode][] = [
  [/\bUPI\b/, "UPI"], [/\bNEFT\b/, "NEFT"], [/\bRTGS\b/, "RTGS"], [/\bIMPS\b/, "IMPS"],
  [/\b(N?ACH|ECS)\b/, "ACH/NACH"], [/\b(ATM|ATW|NWD)\b/, "ATM"], [/\b(CHQ|CHEQUE|CLG)\b/, "Cheque"],
  [/\bCASH\b/, "Cash"], [/\bPOS\b/, "Card"], [/\b(INT|INTEREST|CHRG|CHG|CHARGES|TDS|GST)\b/, "Bank internal"],
];

export function detectMode(narration: string): TransactionMode {
  const text = normalise(narration);
  for (const [pattern, mode] of MODE_PATTERNS) if (pattern.test(text)) return mode;
  return "Other";
}

// Segments that are routing codes, not names.
const NOT_A_NAME = /^(UPI|IMPS|NEFT|RTGS|N?ACH|ECS|P2[AMP]|DR|CR|IN|OUT|PAYMENT|PAY|TRANSFER)$/;

/** Best-effort counterparty from common UPI/IMPS/NEFT/RTGS/NACH layouts; null when not recognised. */
export function extractCounterparty(narration: string): string | null {
  const head = narration.trim().toUpperCase();
  if (head.startsWith("UPI/") || head.startsWith("IMPS/")) {
    const parts = narration.split("/");
    if (parts.length > 3 && parts[3].trim()) return parts[3].trim();
  }
  if (head.startsWith("NEFT") || head.startsWith("RTGS")) {
    const parts = narration.split("-");
    if (parts.length > 2 && parts[2].trim()) return parts[2].trim();
  }
  // Short layouts such as "UPI/RAHUL-MART" or "NEFT SALARY/ACME SYSTEMS PVT LTD": the last segment that reads as a name.
  if (/^(UPI|IMPS|NEFT|RTGS|N?ACH|ECS)\b/.test(head) && narration.includes("/")) {
    const named = narration.split("/").slice(1).map((s) => s.trim())
      .filter((s) => /[A-Za-z]{2}/.test(s) && !NOT_A_NAME.test(s.toUpperCase()) && !/^[A-Za-z]{0,4}\d{6,}$/.test(s));
    if (named.length) return named[named.length - 1];
  }
  return null;
}

// --- difflib.SequenceMatcher(None, a, b).ratio() (no junk; strings are short) ---------------------------

function longestMatch(a: string, b: string, alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
  const b2j = new Map<string, number[]>();
  for (let j = blo; j < bhi; j++) b2j.set(b[j], [...(b2j.get(b[j]) ?? []), j]);
  let besti = alo, bestj = blo, bestsize = 0;
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const next = new Map<number, number>();
    for (const j of b2j.get(a[i]) ?? []) {
      const k = (j2len.get(j - 1) ?? 0) + 1;
      next.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = next;
  }
  return [besti, bestj, bestsize];
}

export function similarity(a: string, b: string): number {
  let matched = 0;
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = longestMatch(a, b, alo, ahi, blo, bhi);
    if (k) {
      matched += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  const total = a.length + b.length;
  return total ? (2 * matched) / total : 1;
}

// --- name matching -----------------------------------------------------------------------------------------

export type NameStrength = "exact" | "partial" | "variant" | "weak";
export type NameMatchResult = { strength: NameStrength; details: string[] };

export function describe(result: NameMatchResult): string {
  return result.details.join("; ");
}

const MIN_TRUNCATION_LEN = 4;
const MIN_TRUNCATION_SHARE = 0.6;
const WEAK_SIMILARITY = 0.7;
const RANK: Record<string, number> = { exact: 5, variant: 4, initial: 3, weak: 2 };

type Kind = [kind: "exact" | "initial" | "variant" | "weak", detail: string];

function tokenKind(tok: string, nameToken: string, threshold: number): Kind | null {
  if (tok === nameToken) return ["exact", ""];
  if (tok.length === 1) return tok === nameToken[0] ? ["initial", `'${tok}' as an initial for ${nameToken}`] : null;
  if (nameToken.length < 4 || tok.length < 3) return null;
  if (nameToken.startsWith(tok)) {
    if (tok.length >= MIN_TRUNCATION_LEN && tok.length >= MIN_TRUNCATION_SHARE * nameToken.length) {
      return ["variant", `'${tok}' as a shortened form of ${nameToken}`];
    }
    return ["weak", `'${tok}' is only a short fragment of ${nameToken}`];
  }
  if (tok.startsWith(nameToken)) {
    return ["weak", `'${tok}' extends ${nameToken} with extra letters and may be a different name`];
  }
  if (tok.length < 4) return null;
  const ratio = similarity(tok, nameToken);
  if (ratio >= threshold) return ["variant", `'${tok}' as a spelling variation of ${nameToken}`];
  if (ratio >= WEAK_SIMILARITY) return ["weak", `'${tok}' only resembles ${nameToken}`];
  return null;
}

function bestToken(nameToken: string, text: string[], used: Set<number>, threshold: number): [number, ...Kind] | null {
  let best: [number, ...Kind] | null = null;
  for (let i = 0; i < text.length; i++) {
    if (used.has(i)) continue;
    const found = tokenKind(text[i], nameToken, threshold);
    if (found && (best === null || RANK[found[0]] > RANK[best[1]])) {
      best = [i, ...found];
      if (found[0] === "exact") break;
    }
  }
  return best;
}

/**
 * Look for a person's name in a narration. Every part must be present in some
 * form; given names may be initials, the surname may not; a single-word name
 * must appear exactly.
 */
export function matchName(name: string, narration: string, threshold = 0.85): NameMatchResult | null {
  const nameTokens = tokens(name).filter((t) => !TITLES.has(t));
  const textTokens = tokens(narration);
  if (!nameTokens.length) return null;
  if (nameTokens.length === 1) return textTokens.includes(nameTokens[0]) ? { strength: "exact", details: [] } : null;

  const used = new Set<number>();
  const positions = new Map<number, number>();
  const kinds: string[] = [];
  const details: string[] = [];
  const surname = nameTokens.length - 1;
  for (const idx of [surname, ...Array.from({ length: surname }, (_, i) => i)]) {
    let found: [number, ...Kind] | null = null;
    if (idx !== surname) {
      const expected = positions.get(surname)! - (surname - idx);
      if (expected >= 0 && expected < textTokens.length && !used.has(expected)) {
        const kind = tokenKind(textTokens[expected], nameTokens[idx], threshold);
        if (kind && kind[0] !== "weak") found = [expected, ...kind];
      }
    }
    found ??= bestToken(nameTokens[idx], textTokens, used, threshold);
    if (found === null) return null;
    const [pos, kind, detail] = found;
    if (idx === surname && kind === "initial") return null;
    used.add(pos);
    positions.set(idx, pos);
    kinds.push(kind);
    if (detail) details.push(detail);
  }
  const ordered = nameTokens.map((_, i) => positions.get(i)!);
  const adjacent = ordered.every((p, i) => i === 0 || p === ordered[i - 1] + 1);
  if (!adjacent) details.push("name parts are not adjacent or in order in the narration");
  const strength: NameStrength = kinds.includes("weak") ? "weak" : kinds.includes("variant") ? "variant"
    : kinds.includes("initial") || !adjacent ? "partial" : "exact";
  return { strength, details };
}
