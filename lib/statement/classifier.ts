// Rule-based transaction classifier (port of backend/itr_intake/classifier.py
// and rules.py). Priority, first match wins:
//   1. Self transfer   2. Family transfer   3. Bank-generated entries
//   4. Specific identifiable sources (profile, then keyword rules)
//   5. Client-specific instructions   6. Recurring credits
//   7. Otherwise "Others – Needs Review", with the reason recorded.
// Categories describe what a transaction appears to be. They are not tax
// conclusions. Classification never changes dates, narrations or amounts.

import { describe, detectMode, extractCounterparty, matchName, normalise, tokens, type NameMatchResult,
  type TransactionMode } from "./text";
import type { Transaction } from "./validation";

export const CATEGORIES = [
  "Salary / Pension", "Business / Professional Receipts", "Rent Received", "Interest – Savings Bank",
  "Interest – FD / RD / Others", "Dividend", "Sale / Redemption of Investments", "Income Tax Refund",
  "Loans Received / Repayment of Loans Given", "Gifts / Receipts from Non-relatives", "Investments – Tax-saving",
  "Investments – Others", "Insurance – Health", "Loan EMI / Repayment", "Loans Given", "Tax Payments", "Donations",
  "Credit Card Payments", "Rent Paid", "Business / Professional Expenses", "Self Transfer", "Family Transfer",
  "Cash Withdrawal", "Cash Deposit", "Personal Expenses", "Bank Charges", "Reversals / Refunds", "Others – Needs Review",
] as const;
export type Category = (typeof CATEGORIES)[number];
export type Confidence = "high" | "medium" | "low";
export type ReviewStatus = "Auto-classified" | "Needs confirmation" | "Needs review";
export type Direction = "credit" | "debit";

export const FLAG_LARGE_CREDIT = "large_credit";
export const FLAG_RECURRING_CREDIT = "recurring_credit";
export const LARGE_CREDIT_THRESHOLD = 5_000_000n; // ₹50,000 in paise; an example review threshold, not a legal one
const NAME_SIMILARITY_THRESHOLD = 0.85;
const RECURRENCE_MIN_OCCURRENCES = 3;
const RECURRENCE_MIN_DAYS = 25;
const RECURRENCE_MAX_DAYS = 35;

export type ClassifiedTransaction = Transaction & {
  mode: TransactionMode;
  counterparty: string | null;
  category: Category;
  classificationReason: string;
  confidence: Confidence;
  reviewStatus: ReviewStatus;
  matchedRule: string;
  flags: string[];
};

export type FamilyMember = { name: string; relation: string; aliases?: string[] };
export type ClientProfile = {
  name: string;
  accounts?: { bankName: string; accountNumber: string; bankIdentifiers?: string[] }[];
  upiIds?: string[];
  mobileNumbers?: string[];
  familyMembers?: FamilyMember[];
  employers?: string[];
  loanAccountNumbers?: string[];
  clientRules?: { description: string; patterns: string[]; category: Category; direction?: Direction }[];
};

type KeywordRule = {
  name: string; category: Category; patterns: string[]; direction?: Direction; exclude?: string[];
  confidence?: Confidence; reviewStatus?: ReviewStatus; note: string;
};
type Result = { category: Category; confidence: Confidence; reviewStatus: ReviewStatus; rule: string; reason: string };

// --- rules (rules.py) -----------------------------------------------------------------------------------------

const TAX_DEPARTMENT_ANY = [String.raw`\bITD\b`, String.raw`\bCBDT\b`, String.raw`\bINCOME ?TAX\b`, String.raw`\bTAX REFUND\b`, String.raw`\bIT REFUND\b`];
const TAX_REFUND = [String.raw`\bINCOME ?TAX REFUND\b`, String.raw`\b(TAX|IT) REFUND\b`, String.raw`\bCBDT\b`, String.raw`\bITD\b.*\bREFUND\b`, String.raw`\bREFUND\b.*\bITD\b`];
const PARTY_TRANSFER = [String.raw`^UPI\b`, String.raw`^(NEFT|RTGS|IMPS) (DR|CR|P2A|P2P|IN|OUT)\b`, String.raw`^IMPS P2A\b`,
  String.raw`^(N?ACH|ECS) (D|DR|C|CR)\b`, String.raw`^(TO|BY) TRANSFER\b`];
const CHARGE = "(CHRG|CHGS?|CHARGES?|FEES?)";
const BANK_CHARGE_PATTERNS = [
  String.raw`\bSMS (ALERT )?${CHARGE}`,
  String.raw`\b(DEBIT CARD|DC|ATM CARD|ATM) (ANNUAL |AMC |ISSUANCE |RENEWAL |REPLACEMENT |TXN |TRANSACTION |WDL )?${CHARGE}`,
  String.raw`\b(MIN(IMUM)? (AVG |AVERAGE )?BAL(ANCE)?|NON MAINT(ENANCE)?|AMB|QAB|MAB) ${CHARGE}`,
  String.raw`\b(NEFT|RTGS|IMPS) (COMM(ISSION)?|${CHARGE})`,
  String.raw`\b(CHQ|CHEQUE) BOOK (ISSUE )?${CHARGE}`,
  String.raw`\b(ECS|NACH|ACH|CHQ|CHEQUE|SI) (RTN|RETURN|BOUNCE|DISHONOU?R) ${CHARGE}`,
  String.raw`\b(ACCOUNT|AC|A C) (KEEPING|MAINTENANCE|CLOSURE) ${CHARGE}`,
  String.raw`\bCASH (HANDLING|DEP(OSIT)?|TXN|TRANSACTION) ${CHARGE}`,
  String.raw`\bBANK (SERVICE )?${CHARGE}`,
  String.raw`\bSTOP PAYMENT ${CHARGE}`,
  String.raw`\bLOCKER (RENT|${CHARGE})`,
  String.raw`\b(C|S|I)?GST ON (SMS|ATM|DEBIT CARD|DC|MIN BAL|AMB|NEFT|RTGS|IMPS|CHQ|CHEQUE|ECS|NACH|BANK|A C|AC)\b`,
  String.raw`^(C|S|I)?GST ON ${CHARGE}`,
  String.raw`^${CHARGE} (FOR )?(SMS|ATM|DEBIT CARD|DC|MIN|AMB|NEFT|RTGS|IMPS|CHQ|CHEQUE|ECS|NACH|ACCOUNT|AC|CASH)\b`,
];
const INVESTMENT_PROVIDERS = [String.raw`\bMUTUAL FUNDS?\b`, String.raw`\bBSE STAR MF\b`, String.raw`\bMF UTIL(ITY|ITIES)?\b`,
  String.raw`\bMF (SIP|PURCHASE|PURCH|REDEMPTION|REDEEM|SWITCH|INVESTMENT)\b`, String.raw`\b(SIP|PURCHASE|PURCH|REDEMPTION|REDEEM) (IN |OF )?MF\b`,
  String.raw`\bCAMS\b`, String.raw`\bKFIN`, String.raw`\bZERODHA\b`, String.raw`\bGROWW\b`, String.raw`\bUPSTOX\b`,
  String.raw`\b(ICICI|HDFC|KOTAK|AXIS) ?(SEC|SECURITIES)\b`, String.raw`\bINDIAN CLEARING CORP`, String.raw`\bNSE CLEARING\b`, String.raw`\bBSE LTD\b`];
const SIP = [String.raw`\b(N?ACH|ECS|SI)\b.*\bSIP\b`, String.raw`\bSIP (INSTAL|INST|PURCHASE|DEBIT|DR)`];
const NOT_A_TAX_CONCLUSION = "The category reflects the instrument type only; eligibility for any deduction must be "
  + "confirmed by the CA from supporting documents.";

export const BANK_RULES: KeywordRule[] = [
  { name: "bank.deposit_interest", category: "Interest – FD / RD / Others", direction: "credit",
    patterns: [String.raw`\b(FD|RD|TD|FIXED DEPOSIT|RECURRING DEPOSIT|TERM DEPOSIT) INT`, String.raw`\bINT(EREST)? (ON )?(FD|RD|TD)\b`],
    exclude: PARTY_TRANSFER, confidence: "high", note: "Interest on a deposit credited by the bank." },
  { name: "bank.savings_interest", category: "Interest – Savings Bank", direction: "credit",
    patterns: [String.raw`\bSB INT`, String.raw`\bSAVINGS? (BANK |AC |ACCOUNT )?INT`, String.raw`\bINT(EREST)? (PD|PAID|CR|CREDIT)\b`],
    exclude: [String.raw`\b(FD|RD|TD|FIXED|RECURRING|TERM)\b`, ...PARTY_TRANSFER], confidence: "high",
    note: "Savings account interest credited by the bank." },
  { name: "bank.tds", category: "Tax Payments", direction: "debit",
    patterns: [String.raw`\bTDS (ON |DEDUCTED |RECOVERED )?(FD|RD|TD|INT|INTEREST|DEPOSIT)\b`, String.raw`\b(INT|INTEREST|FD|RD|TD) TDS\b`,
      String.raw`\bTDS (DEDUCTED|RECOVERED|DEDN)\b`],
    exclude: PARTY_TRANSFER, confidence: "medium", note: "TDS deducted by the bank; verify against Form 26AS / AIS." },
  { name: "bank.charges", category: "Bank Charges", direction: "debit", patterns: BANK_CHARGE_PATTERNS,
    exclude: [String.raw`\bREV(ERSAL|ERSED)?\b`, String.raw`\bREFUND\b`, ...PARTY_TRANSFER], confidence: "high",
    note: "Bank charge or GST on bank charges." },
  { name: "bank.reversal_refund", category: "Reversals / Refunds", direction: "credit",
    patterns: [String.raw`\bREVERSAL\b`, String.raw`\bREVERSED\b`, String.raw`\bREV (OF )?${CHARGE}`, String.raw`\b${CHARGE} REV\b`,
      String.raw`\bREFUND\b`, String.raw`\bCASHBACK\b`],
    exclude: TAX_DEPARTMENT_ANY, confidence: "medium", note: "Reversal or refund credit." },
];

export const SOURCE_RULES: KeywordRule[] = [
  { name: "source.income_tax_refund", category: "Income Tax Refund", direction: "credit", patterns: TAX_REFUND,
    confidence: "high", note: "Credit from the income tax department." },
  { name: "source.tax_payment", category: "Tax Payments", direction: "debit",
    patterns: [String.raw`\bCBDT\b`, String.raw`\bITNS ?28[01]\b`, String.raw`\bADVANCE TAX\b`, String.raw`\bSELF ASSESSMENT TAX\b`,
      String.raw`\bINCOME ?TAX\b`, String.raw`\bTIN NSDL\b`],
    confidence: "high", note: "Payment to the income tax department." },
  { name: "source.salary_keyword", category: "Salary / Pension", direction: "credit",
    patterns: [String.raw`\bSALARY\b`, String.raw`\bPENSION\b`, String.raw`\bSAL (CR|CREDIT|PAY|PAYMENT|FOR|OF|AMT|ADV)\b`,
      String.raw`\bSAL (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)`, String.raw`\b(MONTHLY|MTH|MONTH) SAL\b`],
    confidence: "medium", reviewStatus: "Needs confirmation",
    note: "Narration mentions salary or pension, but the payer is not a listed employer; confirm the source." },
  { name: "source.health_insurance", category: "Insurance – Health", direction: "debit",
    patterns: [String.raw`\bHEALTH INS`, String.raw`\bMEDICLAIM\b`, String.raw`\bSTAR HEALTH\b`, String.raw`\bNIVA BUPA\b`, String.raw`\bCARE HEALTH\b`],
    confidence: "medium", note: "Payment to a health insurer. Policy details must be confirmed from the policy document." },
  { name: "source.tax_saving_instrument", category: "Investments – Tax-saving", direction: "debit",
    patterns: [String.raw`\bPPF\b`, String.raw`\bNPS\b`, String.raw`\bELSS\b`, String.raw`\bSUKANYA\b`, String.raw`\bSSY (A C|AC|ACCOUNT|DEP|DEPOSIT)\b`],
    confidence: "medium", reviewStatus: "Needs review",
    note: `Payment to a PPF/NPS/ELSS-type instrument. ${NOT_A_TAX_CONCLUSION}` },
  { name: "source.dividend", category: "Dividend", direction: "credit",
    patterns: [String.raw`\bDIVIDEND\b`, String.raw`\b(N?ACH|ECS)\b.*\bDIV\b`, String.raw`\bDIV (CR|CREDIT|PAYOUT|PAY|WARRANT)\b`,
      String.raw`\b(FINAL|INTERIM|INT) DIV\b`],
    confidence: "high", note: "Dividend credit." },
  { name: "source.investment_redemption", category: "Sale / Redemption of Investments", direction: "credit",
    patterns: [...INVESTMENT_PROVIDERS, String.raw`\bREDEMPTION\b`, String.raw`\bREDEEM`], confidence: "medium",
    note: "Credit from a mutual fund provider or broker." },
  { name: "source.investment_purchase", category: "Investments – Others", direction: "debit",
    patterns: [...INVESTMENT_PROVIDERS, ...SIP], confidence: "medium", reviewStatus: "Needs review",
    note: "Payment to a mutual fund provider or broker. The scheme type (for example ELSS) cannot be determined from the narration." },
  { name: "source.loan_emi", category: "Loan EMI / Repayment", direction: "debit",
    patterns: [String.raw`\b(LOAN|LN) ?EMI\b`, String.raw`\bEMI (FOR|OF|NO|PAYMENT|PYMT|DEBIT|DR|COLLECTION|AMT)\b`, String.raw`\bEMI \d{3,}`,
      String.raw`\b(N?ACH|ECS|SI)\b.*\bEMI\b`, String.raw`\bLOAN (REPAY|INSTAL|EMI)`, String.raw`\b(HOME|PERSONAL|CAR|VEHICLE|EDUCATION) LOAN\b`],
    confidence: "medium", note: "Loan instalment." },
  { name: "source.loan_disbursal", category: "Loans Received / Repayment of Loans Given", direction: "credit",
    patterns: [String.raw`\bLOAN DISB`, String.raw`\bDISBURS`], confidence: "medium", reviewStatus: "Needs confirmation",
    note: "Loan disbursal credit; confirm the lender." },
  { name: "source.credit_card_payment", category: "Credit Card Payments", direction: "debit",
    patterns: [String.raw`\bCREDIT CARD\b`, String.raw`\bCC (PAYMENT|PYMT|BILL)\b`, String.raw`\bCARD (BILL|PAYMENT)\b`],
    confidence: "medium", note: "Credit card bill payment." },
  { name: "source.cash_withdrawal", category: "Cash Withdrawal", direction: "debit",
    patterns: [String.raw`\bATM\b`, String.raw`\bATW\b`, String.raw`\bNWD\b`, String.raw`\bCASH (WDL|WITHDRAWAL)\b`],
    exclude: PARTY_TRANSFER, confidence: "high", note: "Cash withdrawal." },
  { name: "source.cash_deposit", category: "Cash Deposit", direction: "credit",
    patterns: [String.raw`\bCASH DEP`, String.raw`\bBY CASH\b`, String.raw`\bCDM\b`], confidence: "high", note: "Cash deposit." },
];

const COMPANY_SUFFIXES = new Set(["PVT", "PRIVATE", "LTD", "LIMITED", "LLP", "INC", "CO", "COMPANY", "THE"]);
const regexCache = new Map<string, RegExp>();
const re = (pattern: string) => {
  let compiled = regexCache.get(pattern);
  if (!compiled) regexCache.set(pattern, (compiled = new RegExp(pattern)));
  return compiled;
};

// --- helpers --------------------------------------------------------------------------------------------------

/** "₹1,23,456.78"-style is not used here: Python's "{:,}" groups in thousands. */
export function money(paise: bigint, keepDecimals = true): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = keepDecimals ? `.${String(abs % 100n).padStart(2, "0")}` : "";
  return `₹${negative ? "-" : ""}${whole}${fraction}`;
}

const direction = (t: Transaction): Direction => (t.credit > 0n ? "credit" : "debit");
const digitRuns = (text: string) => text.match(/\d+/g) ?? [];
const onlyDigits = (text: string) => text.replace(/\D/g, "");

function containsNumber(narration: string, number: string): boolean {
  const target = onlyDigits(number);
  return Boolean(target) && digitRuns(narration).some((run) => run.includes(target));
}

const result = (category: Category, confidence: Confidence, reviewStatus: ReviewStatus, rule: string, reason: string): Result =>
  ({ category, confidence, reviewStatus, rule, reason });

// --- rule 1: self transfer ------------------------------------------------------------------------------------

function matchSelf(t: Transaction, p: ClientProfile): Result | null {
  const upper = t.narration.toUpperCase();
  const lower = t.narration.toLowerCase();
  const accounts = p.accounts ?? [];
  for (const acct of accounts) {
    if (onlyDigits(acct.accountNumber).length >= 6 && containsNumber(t.narration, acct.accountNumber)) {
      return result("Self Transfer", "high", "Auto-classified", "self.account_number",
        `Narration contains the client's ${acct.bankName} account number.`);
    }
  }
  for (const upi of p.upiIds ?? []) {
    if (upi && lower.includes(upi.toLowerCase())) {
      return result("Self Transfer", "high", "Auto-classified", "self.upi_id", "Narration contains the client's UPI ID.");
    }
  }
  for (const mobile of p.mobileNumbers ?? []) {
    const digits = onlyDigits(mobile).slice(-10);
    if (digits.length === 10 && digitRuns(t.narration).some((run) => run.endsWith(digits) && run.length <= 12)) {
      return result("Self Transfer", "high", "Auto-classified", "self.mobile_number",
        "Narration contains the client's linked mobile number.");
    }
  }
  const masked = [...upper.matchAll(/[X*]{2,}(\d{4})\b/g)].map((m) => m[1]);
  for (const acct of accounts) {
    const last4 = onlyDigits(acct.accountNumber).slice(-4);
    if (last4 && masked.includes(last4)) {
      return result("Self Transfer", "medium", "Needs confirmation", "self.masked_account",
        `Masked account number ending ${last4} matches the client's ${acct.bankName} account; confirm it is the same account.`);
    }
  }
  const nameMatch = matchName(p.name, t.narration, NAME_SIMILARITY_THRESHOLD);
  if (nameMatch === null || nameMatch.strength === "weak") return null;
  const listed = accounts.filter((a) => [a.bankName, ...(a.bankIdentifiers ?? [])].some((id) => id && upper.includes(id.toUpperCase())))
    .map((a) => a.bankName);
  if (nameMatch.strength === "exact") {
    if (listed.length) {
      return result("Self Transfer", "medium", "Auto-classified", "self.name_listed_bank",
        `Client's name appears with a listed bank (${listed[0]}).`);
    }
    return result("Self Transfer", "medium", "Needs confirmation", "self.name_unlisted_bank",
      "Client's name appears, but not against any of the client's listed banks; confirm this is the client's own account.");
  }
  const family = familyMatches(t, p);
  if (family.some(([, r]) => r.strength === "exact")) return null; // an exact family match is stronger
  const bank = listed.length ? `with a listed bank (${listed[0]})` : "not against any of the client's listed banks";
  let reason = `Client's name matched only partially (${describe(nameMatch)}), ${bank}.`;
  const also = family.filter(([, r]) => r.strength !== "weak").map(([m]) => m);
  if (also.length) reason += ` It could also refer to family member ${also.map((m) => `${m.name} (${m.relation})`).join(", ")}.`;
  return result("Self Transfer", "low", "Needs confirmation", "self.name_partial",
    `${reason} Confirm this is the client's own account.`);
}

// --- rule 2: family transfer ----------------------------------------------------------------------------------

const STRENGTH_ORDER = ["exact", "partial", "variant", "weak"];

function familyMatches(t: Transaction, p: ClientProfile): [FamilyMember, NameMatchResult][] {
  const out: [FamilyMember, NameMatchResult][] = [];
  for (const member of p.familyMembers ?? []) {
    const results = [member.name, ...(member.aliases ?? [])]
      .map((c) => matchName(c, t.narration, NAME_SIMILARITY_THRESHOLD)).filter((r): r is NameMatchResult => r !== null);
    if (results.length) {
      out.push([member, results.reduce((a, b) => (STRENGTH_ORDER.indexOf(b.strength) < STRENGTH_ORDER.indexOf(a.strength) ? b : a))]);
    }
  }
  return out;
}

function matchFamily(t: Transaction, p: ClientProfile): Result | null {
  const matches = familyMatches(t, p).filter(([, r]) => r.strength !== "weak");
  if (!matches.length) return null;
  const exact = matches.filter(([, r]) => r.strength === "exact");
  if (exact.length === 1) {
    const m = exact[0][0];
    return result("Family Transfer", "high", "Auto-classified", "family.name", `Matches listed family member ${m.name} (${m.relation}).`);
  }
  if (matches.length > 1) {
    return result("Family Transfer", "medium", "Needs confirmation", "family.ambiguous",
      `Narration could refer to more than one listed family member: ${matches.map(([m]) => `${m.name} (${m.relation})`).join(", ")}; confirm which.`);
  }
  const [member, r] = matches[0];
  return result("Family Transfer", "medium", "Needs confirmation", r.strength === "partial" ? "family.name_initials" : "family.name_variant",
    `Possibly listed family member ${member.name} (${member.relation}), but the name matched only partially (${describe(r)}); confirm.`);
}

function weakNameHints(t: Transaction, p: ClientProfile): string {
  const hints: string[] = [];
  const client = matchName(p.name, t.narration, NAME_SIMILARITY_THRESHOLD);
  if (client !== null && client.strength === "weak") hints.push(`the client ${p.name} (${describe(client)})`);
  for (const [member, r] of familyMatches(t, p)) {
    if (r.strength === "weak") hints.push(`family member ${member.name} (${describe(r)})`);
  }
  return hints.length ? ` Weak name resemblance to ${hints.join("; ")}, not used for classification.` : "";
}

// --- rules 3-5 ------------------------------------------------------------------------------------------------

function applyKeywordRules(rules: KeywordRule[], t: Transaction): Result | null {
  const text = normalise(t.narration);
  const dir = direction(t);
  for (const rule of rules) {
    if (rule.direction && rule.direction !== dir) continue;
    if (!rule.patterns.some((pat) => re(pat).test(text))) continue;
    if ((rule.exclude ?? []).some((pat) => re(pat).test(text))) continue;
    return result(rule.category, rule.confidence ?? "medium", rule.reviewStatus ?? "Auto-classified", rule.name, rule.note);
  }
  return null;
}

function matchProfileSources(t: Transaction, p: ClientProfile): Result | null {
  const text = ` ${normalise(t.narration)} `;
  if (direction(t) === "credit") {
    for (const employer of p.employers ?? []) {
      const core = tokens(employer).filter((tok) => !COMPANY_SUFFIXES.has(tok)).join(" ");
      if (core && text.includes(` ${core} `)) {
        return result("Salary / Pension", "high", "Auto-classified", "source.employer", `Credit from listed employer ${employer}.`);
      }
    }
  } else {
    for (const loan of p.loanAccountNumbers ?? []) {
      if (containsNumber(t.narration, loan)) {
        return result("Loan EMI / Repayment", "high", "Auto-classified", "source.loan_account",
          "Payment to the client's listed loan account.");
      }
    }
  }
  return null;
}

function matchClientRules(t: Transaction, p: ClientProfile): Result | null {
  const text = normalise(t.narration);
  for (const rule of p.clientRules ?? []) {
    if (rule.direction && rule.direction !== direction(t)) continue;
    if (rule.patterns.some((pat) => re(pat).test(text))) {
      return result(rule.category, "medium", "Auto-classified", "client_rule", `Client instruction: ${rule.description}`);
    }
  }
  return null;
}

// --- rule 6: recurring credits ------------------------------------------------------------------------------------

function sourceKey(t: Transaction, counterparty: string | null): string {
  if (counterparty) return normalise(counterparty);
  return tokens(t.narration).filter((tok) => !/^\d+$/.test(tok)).join(" ");
}

const dayNumber = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;

/** {rowNumber: reason} for unmatched credits that form a recurring pattern. */
function findRecurring(candidates: Transaction[]): Map<number, string> {
  const groups = new Map<string, Transaction[]>();
  for (const t of candidates) {
    const key = sourceKey(t, extractCounterparty(t.narration));
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const found = new Map<number, string>();
  for (const [key, group] of groups) {
    if (!key || group.length < RECURRENCE_MIN_OCCURRENCES) continue;
    group.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    // Median kept doubled (2 x paise) so an even count stays exact.
    const credits = group.map((t) => t.credit).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const n = credits.length;
    const mid2 = n % 2 ? credits[(n - 1) / 2] * 2n : credits[n / 2 - 1] + credits[n / 2];
    // |credit - mid| > mid x 0.10  <=>  |2 credit - mid2| x 10 > mid2
    if (mid2 <= 0n || group.some((t) => {
      const diff = t.credit * 2n - mid2;
      return (diff < 0n ? -diff : diff) * 10n > mid2;
    })) continue;
    const gaps = group.slice(1).map((t, i) => dayNumber(t.date) - dayNumber(group[i].date));
    if (!gaps.every((g) => g >= RECURRENCE_MIN_DAYS && g <= RECURRENCE_MAX_DAYS)) continue;
    const median = mid2 % 2n === 0n ? money(mid2 / 2n) : `${money(mid2 / 2n)}5`;
    const reason = `Recurring credit: ${group.length} credits of about ${median} from the same source ('${key}'), `
      + `${Math.min(...gaps)}–${Math.max(...gaps)} days apart.`;
    for (const t of group) found.set(t.rowNumber, reason);
  }
  return found;
}

// --- orchestration ------------------------------------------------------------------------------------------------

function classifyOne(t: Transaction, p: ClientProfile): Result | null {
  return matchSelf(t, p) ?? matchFamily(t, p) ?? applyKeywordRules(BANK_RULES, t) ?? matchProfileSources(t, p)
    ?? applyKeywordRules(SOURCE_RULES, t) ?? matchClientRules(t, p);
}

/** Priority rules 1-5 for one transaction (no recurring or large-credit pass); null if none match. */
export function classifyTransaction(t: Transaction, p: ClientProfile) {
  const r = classifyOne(t, p);
  return r && { category: r.category, confidence: r.confidence, reviewStatus: r.reviewStatus, matchedRule: r.rule,
    reason: r.reason };
}

/** Classify every transaction, keeping the original order. */
export function classifyStatement(transactions: Transaction[], profile: ClientProfile): ClassifiedTransaction[] {
  const firstPass = transactions.map((t) => [t, classifyOne(t, profile)] as const);
  const recurring = findRecurring(firstPass.filter(([t, r]) => r === null && direction(t) === "credit").map(([t]) => t));
  return firstPass.map(([t, matched]) => {
    let r: Result;
    const flags: string[] = [];
    if (matched) r = matched;
    else if (recurring.has(t.rowNumber)) {
      r = result("Others – Needs Review", "low", "Needs confirmation", "recurring_credit",
        `${recurring.get(t.rowNumber)} The source and nature are not identified; confirm with the client.`);
      flags.push(FLAG_RECURRING_CREDIT);
    } else {
      r = result("Others – Needs Review", "low", "Needs review", "uncertain",
        "No priority rule matched; the nature of this transaction cannot be determined from the narration.");
    }
    if (r.rule === "uncertain" || r.rule === "recurring_credit") r = { ...r, reason: r.reason + weakNameHints(t, profile) };
    if (direction(t) === "credit" && r.category === "Others – Needs Review" && t.credit >= LARGE_CREDIT_THRESHOLD) {
      flags.push(FLAG_LARGE_CREDIT);
      r = { ...r, reviewStatus: "Needs review", reason: `${r.reason} Unexplained credit of ${money(t.credit)} is at or above the `
        + `configured review threshold of ${money(LARGE_CREDIT_THRESHOLD, false)}.` };
    }
    return { ...t, mode: detectMode(t.narration), counterparty: extractCounterparty(t.narration), category: r.category,
      classificationReason: r.reason, confidence: r.confidence, reviewStatus: r.reviewStatus, matchedRule: r.rule, flags };
  });
}
