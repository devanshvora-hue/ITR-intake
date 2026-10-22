// The ITR-oriented summary of a reviewed statement: gross totals per category,
// key figures by head, and review flags (specification sections E, G, H).
// Deterministic arithmetic on stored rows; no tax computation and no legal
// conclusion. Every flag is a prompt for the CA to verify, worded as such, and
// thresholds are configurable settings taken from the specification.

import { CATEGORIES, type Category } from "./classifier";
import { formatPaise } from "./validation";

const LAKH = 100_000n * 100n; // ₹1,00,000 in paise

/** Review thresholds (specification section G). Settings, not legal determinations. */
export const FLAG_THRESHOLDS = {
  /** Cash deposits aggregating this or more in the FY (SFT reporting for savings accounts). */
  cashDepositsAggregate: 10n * LAKH,
  /** A single cash deposit this large is listed. */
  largeCashDeposit: 2n * LAKH,
  /** Cash deposited on one day reaching this may involve a cash receipt covered by s.269ST. */
  cashReceiptsPerDay: 2n * LAKH,
  /** Cash withdrawals aggregating this or more (the lower s.194N threshold; the higher one is ₹1 crore). */
  cashWithdrawalsAggregate: 20n * LAKH,
  /** Gifts from non-relatives aggregating more than this (s.56(2)(x)). */
  giftsAggregate: 50_000n * 100n,
  /** Unexplained credits at or above this are listed (ss.68 / 69A if not explained). */
  unexplainedCredit: 50_000n * 100n,
};

export type SummaryRow = {
  rowNumber: number; date: string; narration: string; debit: bigint; credit: bigint; category: Category;
};

export type CategoryTotal = { category: Category; count: number; debit: string; credit: string; net: string };
export type KeyFigure = { label: string; amount: string; basis: string };
export type ReviewFlag = { code: string; title: string; detail: string; amount: string | null; rows: number[] };

const sum = (rows: SummaryRow[], side: "debit" | "credit") => rows.reduce((a, r) => a + r[side], 0n);
const inCategory = (rows: SummaryRow[], ...categories: Category[]) => rows.filter((r) => categories.includes(r.category));
const rupees = (paise: bigint) => {
  const text = formatPaise(paise);
  const [whole, fraction] = text.replace("-", "").split(".");
  const last3 = whole.slice(-3), rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `₹${paise < 0n ? "-" : ""}${grouped}.${fraction}`;
};

export function categoryTotals(rows: SummaryRow[]): CategoryTotal[] {
  return CATEGORIES.map((category) => {
    const members = inCategory(rows, category);
    const debit = sum(members, "debit"), credit = sum(members, "credit");
    return { category, count: members.length, debit: formatPaise(debit), credit: formatPaise(credit),
      net: formatPaise(credit - debit) };
  });
}

/** "Key Figures for ITR" (specification H): gross amounts as classified, by head. */
export function keyFigures(rows: SummaryRow[]): KeyFigure[] {
  const credit = (c: Category) => formatPaise(sum(inCategory(rows, c), "credit"));
  const debit = (c: Category) => formatPaise(sum(inCategory(rows, c), "debit"));
  const homeLoan = inCategory(rows, "Loan EMI / Repayment").filter((r) => /\b(HOME|HOUSING)\b/i.test(r.narration));
  return [
    { label: "Salary / pension credits", amount: credit("Salary / Pension"), basis: "Match with Form 16." },
    { label: "Business / professional receipts", amount: credit("Business / Professional Receipts"), basis: "Gross receipts; s.44AD / 44ADA check." },
    { label: "Interest – savings bank", amount: credit("Interest – Savings Bank"), basis: "s.80TTA / 80TTB may apply." },
    { label: "Interest – FD / RD / others", amount: credit("Interest – FD / RD / Others"), basis: "Match with AIS / 26AS and TDS." },
    { label: "Rent received", amount: credit("Rent Received"), basis: "Income from house property." },
    { label: "Dividend", amount: credit("Dividend"), basis: "Match with AIS." },
    { label: "Tax-saving investments noticed (80C-type)", amount: debit("Investments – Tax-saving"), basis: "Eligibility to be confirmed." },
    { label: "Health insurance noticed (80D-type)", amount: debit("Insurance – Health"), basis: "Eligibility to be confirmed." },
    { label: "Donations noticed (80G-type)", amount: debit("Donations"), basis: "Subject to mode and regime." },
    { label: "Home loan EMIs noticed (24(b) / 80C)", amount: formatPaise(sum(homeLoan, "debit")),
      basis: "EMIs combine interest and principal; get the lender's certificate." },
    { label: "Tax paid (advance / self-assessment / TDS entries)", amount: debit("Tax Payments"), basis: "Claim in the ITR after matching challans." },
    { label: "Income tax refunds received", amount: credit("Income Tax Refund"), basis: "Not income; interest on refund is taxable." },
  ];
}

/** Review flags (specification G). Each is a prompt for CA verification, never a conclusion. */
export function reviewFlags(rows: SummaryRow[], context: { financialYear: string | null; declaredSources: string[];
  reportsProvided?: boolean; taxReportOpen?: number; taxReportBankOnly?: number }): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const add = (code: string, title: string, detail: string, members: SummaryRow[], amount: bigint | null = null) =>
    flags.push({ code, title, detail, amount: amount === null ? null : formatPaise(amount),
      rows: [...new Set(members.map((r) => r.rowNumber))].sort((a, b) => a - b) });
  const t = FLAG_THRESHOLDS;

  if (context.financialYear && /^\d{4}-\d{2}$/.test(context.financialYear)) {
    const start = Number(context.financialYear.slice(0, 4));
    const outside = rows.filter((r) => r.date < `${start}-04-01` || r.date > `${start + 1}-03-31`);
    if (outside.length) {
      add("outside_financial_year", "Transactions outside the financial year",
        `${outside.length} transaction(s) are dated outside FY ${context.financialYear}. They are included in the totals; exclude them if they do not belong to this return.`, outside);
    }
  }

  const deposits = inCategory(rows, "Cash Deposit");
  const depositTotal = sum(deposits, "credit");
  if (depositTotal >= t.cashDepositsAggregate) {
    add("cash_deposits_sft", "Cash deposits of ₹10 lakh or more",
      `Cash deposits total ${rupees(depositTotal)} in the period. Aggregates of ₹10 lakh or more in savings accounts are reported to the department (SFT); confirm the source of the cash.`, deposits, depositTotal);
  }
  const bigDeposits = deposits.filter((r) => r.credit >= t.largeCashDeposit);
  if (bigDeposits.length) {
    add("large_cash_deposit", "Large single cash deposits",
      `${bigDeposits.length} cash deposit(s) of ${rupees(t.largeCashDeposit)} or more. Confirm the source of each.`, bigDeposits, sum(bigDeposits, "credit"));
  }
  const byDay = new Map<string, SummaryRow[]>();
  for (const r of deposits) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);
  const heavyDays = [...byDay.values()].filter((day) => sum(day, "credit") >= t.cashReceiptsPerDay).flat();
  if (heavyDays.length) {
    add("cash_receipts_269st", "Possible cash receipts of ₹2 lakh or more (s.269ST)",
      "Cash of ₹2 lakh or more was deposited on a single day. Check whether any of it was received in cash from one person, in one day or for one transaction.", heavyDays, sum(heavyDays, "credit"));
  }
  const withdrawals = inCategory(rows, "Cash Withdrawal");
  const withdrawn = sum(withdrawals, "debit");
  if (withdrawn >= t.cashWithdrawalsAggregate) {
    add("cash_withdrawals_194n", "Cash withdrawals near s.194N thresholds",
      `Cash withdrawals total ${rupees(withdrawn)}. Check s.194N (TDS on cash withdrawals above ₹20 lakh for non-filers, ₹1 crore otherwise) and whether TDS appears.`, withdrawals, withdrawn);
  }

  const gifts = inCategory(rows, "Gifts / Receipts from Non-relatives");
  const giftTotal = sum(gifts, "credit");
  if (giftTotal > t.giftsAggregate) {
    add("gifts_56_2_x", "Receipts from non-relatives above ₹50,000",
      `Credits classified as gifts or receipts from non-relatives total ${rupees(giftTotal)}. Above ₹50,000 in aggregate they may be taxable (s.56(2)(x)) unless explained.`, gifts, giftTotal);
  }
  const unexplained = inCategory(rows, "Others – Needs Review").filter((r) => r.credit >= t.unexplainedCredit);
  if (unexplained.length) {
    add("unexplained_credits", "Large unexplained credits",
      `${unexplained.length} credit(s) of ${rupees(t.unexplainedCredit)} or more are not explained. Credits not supported by evidence may be questioned (ss.68 / 69A); get the source from the client.`, unexplained, sum(unexplained, "credit"));
  }

  const salary = inCategory(rows, "Salary / Pension");
  const receipts = inCategory(rows, "Business / Professional Receipts");
  const declared = new Set(context.declaredSources);
  if ((salary.length && declared.has("business") && !declared.has("salary"))
      || (receipts.length && declared.has("salary") && !declared.has("business"))) {
    add("head_of_income", "Check the head of income",
      "Credits are labelled differently from what the client declared (salary versus business or professional receipts). Confirm the correct head of income.", [...salary, ...receipts]);
  }

  const interest = inCategory(rows, "Interest – Savings Bank", "Interest – FD / RD / Others");
  if (interest.length) {
    const tds = rows.filter((r) => r.debit > 0n && /\bTDS\b/i.test(r.narration));
    add("interest_income", "Interest income to match with AIS / 26AS",
      `Interest credited totals ${rupees(sum(interest, "credit"))}. ${tds.length ? `TDS appears in ${tds.length} entr${tds.length === 1 ? "y" : "ies"}.` : "No TDS entry appears in this statement."} Match with AIS / Form 26AS.`, [...interest, ...tds], sum(interest, "credit"));
  }

  const deductions: [Category, string][] = [["Investments – Tax-saving", "80C / 80CCD"], ["Insurance – Health", "80D"], ["Donations", "80G"]];
  const noticed = deductions.filter(([c]) => inCategory(rows, c).length);
  const homeLoan = inCategory(rows, "Loan EMI / Repayment").filter((r) => /\b(HOME|HOUSING)\b/i.test(r.narration));
  const sb = inCategory(rows, "Interest – Savings Bank");
  if (noticed.length || homeLoan.length || sb.length) {
    const parts = [...noticed.map(([c, s]) => `${s}: ${rupees(sum(inCategory(rows, c), "debit"))}`),
      ...(homeLoan.length ? [`24(b) / 80C (home loan EMIs, interest and principal combined): ${rupees(sum(homeLoan, "debit"))}`] : []),
      ...(sb.length ? [`80TTA / 80TTB (savings interest): ${rupees(sum(sb, "credit"))}`] : [])];
    add("possible_deductions", "Possible deductions noticed",
      `${parts.join("; ")}. Amounts are as per the bank statement only. Most of these deductions are available only under the old tax regime; confirm eligibility from supporting documents.`,
      [...noticed.flatMap(([c]) => inCategory(rows, c)), ...homeLoan, ...sb]);
  }

  const redemptions = inCategory(rows, "Sale / Redemption of Investments");
  if (redemptions.length) {
    add("capital_gains_events", "Possible capital gains events",
      `${redemptions.length} sale or redemption credit(s) totalling ${rupees(sum(redemptions, "credit"))}. Bank credits show sale proceeds, not gains: obtain the broker / RTA capital gains statement.`, redemptions, sum(redemptions, "credit"));
  }
  const loans = inCategory(rows, "Loans Received / Repayment of Loans Given", "Loans Given");
  if (loans.length) {
    add("loans", "Loans given or received",
      "Loans given or received need confirmation from the other party and a check of any interest.", loans);
  }
  const family = inCategory(rows, "Family Transfer").filter((r) => r.debit > 0n);
  if (family.length) {
    add("possible_clubbing", "Transfers to family members",
      "Check whether transfers to a spouse, minor child or daughter-in-law funded investments or deposits in their names (possible clubbing, s.64).", family, sum(family, "debit"));
  }
  if (context.reportsProvided && ((context.taxReportOpen ?? 0) > 0 || (context.taxReportBankOnly ?? 0) > 0)) {
    const open = context.taxReportOpen ?? 0, bankOnly = context.taxReportBankOnly ?? 0;
    add("tax_report_differences", "AIS / TIS / Form 26AS differences",
      `${open} report entr${open === 1 ? "y is" : "ies are"} not yet reconciled with the bank statement`
      + `${bankOnly ? `, and ${bankOnly} income credit${bankOnly === 1 ? "" : "s"} in the bank statement ${bankOnly === 1 ? "does" : "do"} not appear in the reports` : ""}. `
      + "Resolve or explain each difference before relying on the figures.", []);
  }
  if (!context.reportsProvided) {
    add("tax_reports_not_provided", "AIS / TIS / Form 26AS not provided",
      "No AIS, TIS or Form 26AS was provided, so interest, dividend, TDS and SFT entries have not been reconciled with them.", []);
  }
  return flags;
}
