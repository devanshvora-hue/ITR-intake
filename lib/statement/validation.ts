// Deterministic statement validation (ported from itr_intake/validation.py).
// Money is exact: whole paise as bigint, never floating point. Nothing here
// adjusts an amount; invalid rows are reported, never repaired.

export const RECONCILIATION_TOLERANCE = 1n; // 0.01 in paise

export type RawTransaction = {
  rowNumber: number;
  date: string | null;
  narration: string | null;
  debit: string | null;
  credit: string | null;
  balance: string | null;
};

export type Transaction = {
  rowNumber: number;
  date: string; // YYYY-MM-DD
  narration: string;
  debit: bigint;
  credit: bigint;
  balance: bigint | null;
  rawDebit: string | null;
  rawCredit: string | null;
  rawBalance: string | null;
};

export type ValidationIssue = { rowNumber: number; field: string; code: string };

export class AmountError extends Error {
  constructor(readonly negative: boolean) {
    super(negative ? "negative amount" : "not a number");
  }
}

/** Parse an amount exactly into paise. Blank means zero; commas and "₹" are ignored. */
export function parseAmount(raw: string | null | undefined, allowNegative = false): bigint {
  if (raw === null || raw === undefined) return 0n;
  const text = raw.trim().replace(/,/g, "").replace(/₹/g, "").trim();
  if (text === "" || text === "-") return 0n;
  const m = /^([+-])?(\d+)(?:\.(\d{1,2}))?$|^([+-])?\.(\d{1,2})$/.exec(text);
  if (!m) throw new AmountError(false);
  const sign = (m[1] ?? m[4]) === "-" ? -1n : 1n;
  const whole = BigInt(m[2] ?? "0");
  const fraction = BigInt(((m[3] ?? m[5] ?? "") + "00").slice(0, 2));
  const value = sign * (whole * 100n + fraction);
  if (value < 0n && !allowNegative) throw new AmountError(true);
  return value;
}

/** Paise as decimal text, e.g. 125050n -> "1250.50". */
export function formatPaise(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY = "(3[01]|[12]\\d|0[1-9]|[1-9])";
const MONTH = "(1[0-2]|0[1-9]|[1-9])";
const MON = "([A-Za-z]{3})";

// The project's date formats, day first only (AnalysisConfig.date_formats):
// %d/%m/%Y, %d-%m-%Y, %d.%m.%Y, %Y-%m-%d, %d-%b-%Y, %d %b %Y, %d/%m/%y.
const FORMATS: { pattern: RegExp; order: "dmy" | "ymd" | "dby" | "dmy2" }[] = [
  { pattern: new RegExp(`^${DAY}/${MONTH}/(\\d{4})$`), order: "dmy" },
  { pattern: new RegExp(`^${DAY}-${MONTH}-(\\d{4})$`), order: "dmy" },
  { pattern: new RegExp(`^${DAY}\\.${MONTH}\\.(\\d{4})$`), order: "dmy" },
  { pattern: new RegExp(`^(\\d{4})-${MONTH}-${DAY}$`), order: "ymd" },
  { pattern: new RegExp(`^${DAY}-${MON}-(\\d{4})$`), order: "dby" },
  { pattern: new RegExp(`^${DAY} ${MON} (\\d{4})$`), order: "dby" },
  { pattern: new RegExp(`^${DAY}/${MONTH}/(\\d{2})$`), order: "dmy2" },
];

function isoDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A day-first date in one of the project's formats as "YYYY-MM-DD"; throws if unrecognised or impossible. */
export function parseDate(raw: string): string {
  const text = raw.trim();
  for (const { pattern, order } of FORMATS) {
    const m = pattern.exec(text);
    if (!m) continue;
    let result: string | null = null;
    if (order === "dmy") result = isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
    else if (order === "ymd") result = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    else if (order === "dby") {
      const month = MONTHS.indexOf(m[2].toLowerCase());
      result = month < 0 ? null : isoDate(Number(m[3]), month + 1, Number(m[1]));
    } else {
      const yy = Number(m[3]);
      result = isoDate(yy < 69 ? 2000 + yy : 1900 + yy, Number(m[2]), Number(m[1]));
    }
    if (result) return result;
  }
  throw new Error("unrecognised or impossible date");
}

function validateRow(row: RawTransaction): { txn: Transaction | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const err = (field: string, code: string) => issues.push({ rowNumber: row.rowNumber, field, code });
  let date: string | null = null;
  if (row.date === null || !row.date.trim()) err("date", "missing_date");
  else {
    try {
      date = parseDate(row.date);
    } catch {
      err("date", "invalid_date");
    }
  }
  if (row.narration === null || !row.narration.trim()) err("narration", "missing_narration");
  const amounts: { debit?: bigint; credit?: bigint } = {};
  for (const name of ["debit", "credit"] as const) {
    try {
      amounts[name] = parseAmount(row[name]);
    } catch (e) {
      err(name, (e as AmountError).negative ? "negative_amount" : "invalid_amount");
    }
  }
  let balance: bigint | null = null;
  if (row.balance !== null && row.balance.trim()) {
    try {
      balance = parseAmount(row.balance, true);
    } catch {
      err("balance", "invalid_amount");
    }
  }
  if (amounts.debit !== undefined && amounts.credit !== undefined) {
    if (amounts.debit > 0n && amounts.credit > 0n) err("amount", "both_debit_and_credit");
    else if (amounts.debit === 0n && amounts.credit === 0n) err("amount", "missing_amount");
  }
  if (issues.length) return { txn: null, issues };
  return {
    txn: {
      rowNumber: row.rowNumber, date: date as string, narration: row.narration as string,
      debit: amounts.debit as bigint, credit: amounts.credit as bigint, balance,
      rawDebit: row.debit, rawCredit: row.credit, rawBalance: row.balance,
    },
    issues,
  };
}

/** Validate rows; errors per row, valid transactions in order. */
export function validateRows(rows: RawTransaction[]): { transactions: Transaction[]; errors: ValidationIssue[] } {
  const transactions: Transaction[] = [];
  const errors: ValidationIssue[] = [];
  for (const row of rows) {
    const { txn, issues } = validateRow(row);
    errors.push(...issues);
    if (txn) transactions.push(txn);
  }
  return { transactions, errors };
}

/** True when every stated running balance follows from the previous one (within 0.01). */
export function balanceChainHolds(transactions: Transaction[], opening: bigint): boolean {
  let running = opening;
  for (const t of transactions) {
    running = running + t.credit - t.debit;
    if (t.balance !== null) {
      const diff = t.balance - running;
      if ((diff < 0n ? -diff : diff) > RECONCILIATION_TOLERANCE) return false;
      running = t.balance;
    }
  }
  return true;
}
