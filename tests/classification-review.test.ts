// Classification of common narrations (specification E/F), the CA's category
// decisions (persisted, audited, isolated), the ITR summary flags (G) and the
// workbook (H). Synthetic narrations and statements only.

import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as detailRoute } from "@/app/api/ca/cases/[reference]/route";
import { POST as reviewRoute } from "@/app/api/ca/cases/[reference]/review/route";
import { POST as decideRoute } from "@/app/api/ca/cases/[reference]/review/rows/[rowNumber]/route";
import { GET as workbookRoute } from "@/app/api/ca/cases/[reference]/workbook/route";
import { POST as createCode } from "@/app/api/ca/firm-code/route";
import { POST as openCase } from "@/app/api/client/cases/route";
import { POST as saveProfile } from "@/app/api/client/cases/[reference]/profile/route";
import { POST as uploadRoute } from "@/app/api/client/cases/[reference]/statements/route";
import { POST as start } from "@/app/api/client/start/route";
import type { ReviewRow } from "@/lib/case-review";
import { financialYearOptions } from "@/lib/server/client-auth";
import { MemoryStore, setFileStoreForTests } from "@/lib/server/storage";
import { CATEGORIES, classifyStatement, type ClientProfile } from "@/lib/statement/classifier";
import { categoryTotals, keyFigures, reviewFlags, type SummaryRow } from "@/lib/statement/itr-summary";
import type { Transaction } from "@/lib/statement/validation";
import { onboardCa } from "./helpers/ca";
import { Client, env, rows, setupTestServer } from "./helpers/http";

const rupees = (r: number) => BigInt(Math.round(r * 100));
let n = 0;
const txn = (narration: string, debit: number, credit = 0, date = "2025-05-10"): Transaction => ({
  rowNumber: ++n, date, narration, debit: rupees(debit), credit: rupees(credit), balance: null,
  rawDebit: null, rawCredit: null, rawBalance: null,
});
const PROFILE: ClientProfile = { name: "Asha Rao" };
const one = (t: Transaction, profile: ClientProfile = PROFILE) => classifyStatement([t], profile)[0];
const summary = (t: Transaction, profile?: ClientProfile) => {
  const c = one(t, profile);
  return [c.category, c.confidence, c.reviewStatus];
};

describe("classification of common narrations", () => {
  it("classifies the specification's examples without over-reaching", () => {
    expect(summary(txn("UPI/MAHARASHTRA ELECTRICITY", 2340))).toEqual(["Personal Expenses", "medium", "Auto-classified"]);
    const sip = one(txn("NACH MUTUAL FUND SIP/DEMO AMC", 5000));
    expect([sip.category, sip.reviewStatus]).toEqual(["Investments – Others", "Auto-classified"]);
    expect(sip.classificationReason).toMatch(/scheme type .* cannot be determined/);
    const salary = one(txn("NEFT SALARY/DEMO SYSTEMS PVT LTD", 0, 85000));
    expect([salary.category, salary.reviewStatus, salary.counterparty]).toEqual(["Salary / Pension", "Needs confirmation",
      "DEMO SYSTEMS PVT LTD"]);
    expect(salary.classificationReason).toMatch(/confirm the source/);
    const mart = one(txn("UPI/RAHUL-MART", 640));
    expect([mart.category, mart.confidence, mart.reviewStatus]).toEqual(["Personal Expenses", "medium", "Auto-classified"]);
    expect(mart.classificationReason).toBe("UPI payment to what appears to be a merchant (RAHUL-MART); treated as a personal expense.");
  });

  it("covers bills, cash, bank entries, tax, cards, loans and insurance", () => {
    const cases: [string, number, number, string, string][] = [
      ["BBPS/AIRTEL POSTPAID BILL", 799, 0, "Personal Expenses", "source.utility_bill"],
      ["UPI/P2M/512345678901/ACT FIBERNET/Payment", 1180, 0, "Personal Expenses", "source.utility_bill"],
      ["POS 4321XXXX SYNTHETIC SUPERSTORE", 1450, 0, "Personal Expenses", "source.card_spend"],
      ["UPI/P2M/512399990000/AMAZON PAY INDIA/Order", 1299, 0, "Personal Expenses", "source.known_merchant"],
      ["ATM CASH WDL 01234 SYNTH BRANCH", 20000, 0, "Cash Withdrawal", "source.cash_withdrawal"],
      ["BY CASH DEPOSIT SYNTH BRANCH", 0, 15000, "Cash Deposit", "source.cash_deposit"],
      ["CREDIT INTEREST", 0, 312.4, "Interest – Savings Bank", "bank.savings_interest"],
      ["SMS ALERT CHARGES INCL GST", 17.7, 0, "Bank Charges", "bank.charges"],
      ["REFUND AMAZON ORDER 12345", 0, 499, "Reversals / Refunds", "bank.reversal_refund"],
      ["ITNS 280 ADVANCE TAX CHALLAN", 15000, 0, "Tax Payments", "source.tax_payment"],
      ["CBDT INCOME TAX REFUND AY 2025-26", 0, 4200, "Income Tax Refund", "source.income_tax_refund"],
      ["CRED CLUB CREDIT CARD BILL", 18500, 0, "Credit Card Payments", "source.credit_card_payment"],
      ["ACH/SYNTH HOME LOAN EMI/0000123456789", 32450, 0, "Loan EMI / Repayment", "source.loan_emi"],
      ["LIC PREMIUM SYNTH POLICY 912345678", 24150, 0, "Investments – Tax-saving", "source.life_insurance"],
      ["STAR HEALTH INSURANCE PREMIUM", 18000, 0, "Insurance – Health", "source.health_insurance"],
      ["NEFT-SYNTH998877-CAMS MF REDEMPTION", 0, 75000, "Sale / Redemption of Investments", "source.investment_redemption"],
      ["IMPS/P2A/512398765432/SYNTH TENANT/Rent Apr", 0, 25000, "Rent Received", "source.rent_received"],
    ];
    for (const [narration, debit, credit, category, rule] of cases) {
      const c = one(txn(narration, debit, credit));
      expect([narration, c.category, c.matchedRule]).toEqual([narration, category, rule]);
      expect(c.classificationReason.length).toBeGreaterThan(10);
    }
  });

  it("keeps genuinely unknown and large items for manual review, never in an income category", () => {
    const credit = one(txn("NEFT-SYNTH0099-UNKNOWN PARTY-REF", 0, 60000));
    expect([credit.category, credit.reviewStatus, credit.flags]).toEqual(["Others – Needs Review", "Needs review", ["large_credit"]]);
    const upiCredit = one(txn("UPI/P2P/512311112222/9876543210@ybl/Thanks", 0, 900));
    expect(upiCredit.category).toBe("Others – Needs Review");
    const bigPayment = one(txn("UPI/P2A/512300001111/VIKRAM SYNTH/Transfer", 40000));
    expect([bigPayment.category, bigPayment.reviewStatus]).toEqual(["Others – Needs Review", "Needs review"]);
    expect(bigPayment.classificationReason).toMatch(/too large to assume a personal expense/);
    const small = one(txn("UPI/P2A/512300001112/VIKRAM SYNTH/Dinner", 850));
    expect([small.category, small.confidence, small.reviewStatus]).toEqual(["Personal Expenses", "low", "Needs confirmation"]);
    expect(small.classificationReason).toMatch(/Provisionally a personal expense/);
  });

  it("applies the priority order: self and family first, specific payees before client instructions and UPI patterns", () => {
    const profile: ClientProfile = { name: "Asha Rao", familyMembers: [{ name: "Ravi Rao", relation: "spouse" }],
      clientRules: [{ description: "Treat all UPI as personal expenses", patterns: [String.raw`\bUPI\b`], category: "Personal Expenses" }] };
    expect(one(txn("UPI/P2A/512311110000/ASHA RAO/Own account", 5000), profile).category).toBe("Self Transfer");
    expect(one(txn("UPI/P2A/512311110001/RAVI RAO/Household", 5000), profile).category).toBe("Family Transfer");
    expect(one(txn("UPI/MAHARASHTRA ELECTRICITY", 2340), profile).matchedRule).toBe("source.utility_bill");
    expect(one(txn("UPI/P2A/512300001113/VIKRAM SYNTH/Misc", 40000), profile).matchedRule).toBe("client_rule");
  });

  it("uses what the client declared", () => {
    const declaredSalary = one(txn("NEFT SALARY/DEMO SYSTEMS PVT LTD", 0, 85000), { name: "Asha Rao", declaredSources: ["salary"] });
    expect([declaredSalary.category, declaredSalary.reviewStatus]).toEqual(["Salary / Pension", "Auto-classified"]);
    expect(declaredSalary.classificationReason).toMatch(/client declared salary income/);
    const business = one(txn("UPI/RAHUL-MART", 640), { name: "Asha Rao", declaredSources: ["business"] });
    expect([business.category, business.reviewStatus]).toEqual(["Personal Expenses", "Needs confirmation"]);
  });

  it("gives every transaction exactly one known category and a reason", () => {
    const mixed = ["UPI/RAHUL-MART", "NEFT SALARY/DEMO", "X", "UPI/P2P/1/Y/z", "ATM WDL", "INT.PD"].map((s, i) =>
      txn(s, i % 2 ? 0 : 100 + i, i % 2 ? 100 + i : 0));
    for (const c of classifyStatement(mixed, PROFILE)) {
      expect(CATEGORIES).toContain(c.category);
      expect(c.classificationReason).toBeTruthy();
    }
  });
});

describe("ITR summary and review flags", () => {
  const row = (rowNumber: number, category: SummaryRow["category"], debit: number, credit: number, narration = "SYNTH",
    date = "2025-06-01"): SummaryRow => ({ rowNumber, date, narration, debit: rupees(debit), credit: rupees(credit), category });
  const codes = (rs: SummaryRow[], declared: string[] = []) =>
    reviewFlags(rs, { financialYear: "2025-26", declaredSources: declared }).map((f) => f.code);

  it("raises prompts for cash, gifts, unexplained credits, deductions, capital gains and loans", () => {
    const rs = [
      row(1, "Cash Deposit", 0, 600000, "CASH", "2025-06-01"), row(2, "Cash Deposit", 0, 450000, "CASH", "2025-07-01"),
      row(3, "Cash Withdrawal", 2100000, 0), row(4, "Gifts / Receipts from Non-relatives", 0, 60000),
      row(5, "Others – Needs Review", 0, 75000), row(6, "Investments – Tax-saving", 24150, 0),
      row(7, "Loan EMI / Repayment", 32450, 0, "HOME LOAN EMI"), row(8, "Interest – Savings Bank", 0, 1200),
      row(9, "Sale / Redemption of Investments", 0, 90000), row(10, "Loans Given", 50000, 0),
      row(11, "Others – Needs Review", 0, 10, "LATE", "2026-04-02"),
    ];
    expect(codes(rs)).toEqual(["outside_financial_year", "cash_deposits_sft", "large_cash_deposit", "cash_receipts_269st",
      "cash_withdrawals_194n", "gifts_56_2_x", "unexplained_credits", "interest_income", "possible_deductions",
      "capital_gains_events", "loans", "tax_reports_not_provided"]);
    const deductions = reviewFlags(rs, { financialYear: "2025-26", declaredSources: [] }).find((f) => f.code === "possible_deductions")!;
    expect(deductions.detail).toMatch(/80C \/ 80CCD: ₹24,150.00; 24\(b\).*₹32,450.00; 80TTA \/ 80TTB.*₹1,200.00/);
    expect(deductions.detail).toMatch(/old tax regime/);
  });

  it("stays quiet when nothing applies, and checks the head of income against what the client declared", () => {
    expect(codes([row(1, "Personal Expenses", 500, 0)])).toEqual(["tax_reports_not_provided"]);
    expect(codes([row(1, "Salary / Pension", 0, 85000)], ["business"])).toContain("head_of_income");
    expect(codes([row(1, "Salary / Pension", 0, 85000)], ["salary"])).not.toContain("head_of_income");
  });

  it("totals every category gross, without netting", () => {
    const totals = categoryTotals([row(1, "Personal Expenses", 500, 0), row(2, "Reversals / Refunds", 0, 200)]);
    expect(totals).toHaveLength(28);
    expect(totals.find((t) => t.category === "Personal Expenses")).toEqual({ category: "Personal Expenses", count: 1,
      debit: "500.00", credit: "0.00", net: "-500.00" });
    expect(keyFigures([row(1, "Salary / Pension", 0, 85000)])[0]).toMatchObject({ label: "Salary / pension credits", amount: "85000.00" });
  });
});

// --- through the routes: decisions persist, are audited and stay inside the firm ---------------------------------

setupTestServer();
beforeEach(() => setFileStoreForTests(new MemoryStore()));
afterEach(() => setFileStoreForTests(null));

const FY = financialYearOptions().includes("2025-26") ? "2025-26" : financialYearOptions()[0];
const CSV = new TextEncoder().encode([
  "Date,Narration,Debit,Credit,Balance",
  "01/04/2025,UPI/MAHARASHTRA ELECTRICITY,2340.00,,97660.00",
  "02/04/2025,NEFT SALARY/DEMO SYSTEMS PVT LTD,,85000.00,182660.00",
  "03/04/2025,NACH MUTUAL FUND SIP/DEMO AMC,5000.00,,177660.00",
  "04/04/2025,UPI/RAHUL-MART,640.00,,177020.00",
  "05/04/2025,NEFT-SYNTH0099-UNKNOWN PARTY-REF,,60000.00,237020.00",
  "32/04/2025,SYNTH BAD DATE ROW,10.00,,237010.00",
].join("\n") + "\n");

async function prepared(tag = "a") {
  const ca = await onboardCa(tag);
  const code = (await (await ca.post(createCode)).json()).firm_code.code;
  const client = new Client();
  await client.post(start, { firm_code: code, email: `client-${tag}@example.test` });
  const { reference } = (await (await client.post(openCase, { first_name: "Asha", financial_year: FY })).json()).case;
  await client.post(saveProfile, { full_name: "Asha Rao", bank_name: "Synthetic Bank Ltd", account_last4: "1234" }, { params: { reference } });
  const upload = await client.call(uploadRoute, { method: "POST", params: { reference }, rawBody: CSV,
    headers: { "content-type": "text/csv", "x-upload-filename": "s.csv" } });
  const statementId = (await upload.json()).statement.id;
  expect((await ca.post(reviewRoute, { statement_id: statementId }, { params: { reference } })).status).toBe(200);
  return { ca, client, reference, statementId };
}

const review = async (ca: Client, reference: string) => (await (await ca.get(detailRoute, { params: { reference } })).json()).review;
const decide = (ca: Client, reference: string, rowNumber: number, body: Record<string, unknown>, extra = {}) =>
  ca.post(decideRoute, body, { params: { reference, rowNumber: String(rowNumber) }, ...extra });
const byRow = (r: { rows: ReviewRow[] }, rowNumber: number) => r.rows.find((x) => x.row_number === rowNumber)!;

describe("CA category decisions", () => {
  it("separates auto, confirm, manual and rejected rows", async () => {
    const { ca, reference } = await prepared();
    const r = await review(ca, reference);
    expect(r.rows.map((x: ReviewRow) => [x.row_number, x.group, x.category])).toEqual([
      [1, "auto", "Personal Expenses"], [2, "confirm", "Salary / Pension"], [3, "auto", "Investments – Others"],
      [4, "auto", "Personal Expenses"], [5, "manual", "Others – Needs Review"], [6, "rejected", null]]);
    expect(r.totals).toMatchObject({ auto: 3, confirm: 1, manual: 1, reviewed: 0, rejected: 1, needs_review: 2 });
    expect(r.itr.flags.map((f: { code: string }) => f.code)).toContain("unexplained_credits");
  });

  it("changes, confirms and withdraws a decision without touching the extracted row, and audits each", async () => {
    const { ca, reference, statementId } = await prepared();
    const changed = await decide(ca, reference, 5, { category: "Business / Professional Receipts", note: "Consulting fee per client" });
    expect(changed.status).toBe(200);
    expect((await changed.json()).row).toMatchObject({ category: "Business / Professional Receipts", group: "reviewed",
      classifier_category: "Others – Needs Review", decision: { decision: "changed", note: "Consulting fee per client" } });
    await decide(ca, reference, 2, { category: "Salary / Pension" });
    let r = await review(ca, reference);
    expect(byRow(r, 2).decision?.decision).toBe("confirmed");
    expect(r.totals).toMatchObject({ confirm: 0, manual: 0, reviewed: 2 });
    expect(r.itr.flags.map((f: { code: string }) => f.code)).not.toContain("unexplained_credits");
    expect(r.itr.categories.find((c: { category: string }) => c.category === "Business / Professional Receipts"))
      .toMatchObject({ count: 1, credit: "60000.00" });
    // The extracted and classified row itself is unchanged.
    expect(await rows("SELECT category, raw_narration, credit::text AS credit FROM statement_rows WHERE row_number = 5"))
      .toEqual([{ category: "Others – Needs Review", raw_narration: "NEFT-SYNTH0099-UNKNOWN PARTY-REF", credit: "60000.00" }]);

    // Preparing the same statement again keeps the decisions.
    await ca.post(reviewRoute, { statement_id: statementId }, { params: { reference } });
    r = await review(ca, reference);
    expect([byRow(r, 5).category, byRow(r, 5).group]).toEqual(["Business / Professional Receipts", "reviewed"]);

    expect((await decide(ca, reference, 5, { category: null })).status).toBe(200);
    r = await review(ca, reference);
    expect([byRow(r, 5).category, byRow(r, 5).group, byRow(r, 5).decision]).toEqual(["Others – Needs Review", "manual", null]);
    expect((await rows<{ action: string; details_json: Record<string, unknown> }>(
      "SELECT action, details_json FROM audit_events WHERE action LIKE 'case.classification%' ORDER BY created_at"))
      .map((a) => [a.action, a.details_json.row_number, a.details_json.to])).toEqual([
      ["case.classification_changed", 5, "Business / Professional Receipts"], ["case.classification_confirmed", 2, "Salary / Pension"],
      ["case.classification_reset", 5, "Others – Needs Review"]]);
  });

  it("never applies a decision to a row that no longer reads the same", async () => {
    const { ca, reference } = await prepared();
    await decide(ca, reference, 4, { category: "Business / Professional Expenses" });
    await env.db.query("UPDATE statement_rows SET raw_narration = 'UPI/SOMETHING ELSE' WHERE row_number = 4");
    const r = await review(ca, reference);
    expect([byRow(r, 4).category, byRow(r, 4).decision]).toEqual(["Personal Expenses", null]);
    // Kept, not applied, and reported so the CA can redo it.
    expect(r.totals.stale_decisions).toBe(1);
    expect(await rows("SELECT category FROM classification_corrections")).toEqual([{ category: "Business / Professional Expenses" }]);
  });

  it("treats a decided large credit as explained everywhere, including the workbook", async () => {
    const { ca, reference } = await prepared();
    await decide(ca, reference, 5, { category: "Business / Professional Receipts", note: "Consulting fee" });
    const r = await review(ca, reference);
    expect(r.itr.flags.map((f: { code: string }) => f.code)).not.toContain("unexplained_credits");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await (await ca.get(workbookRoute, { params: { reference } })).arrayBuffer());
    const needs = wb.getWorksheet("Needs Review")!;
    const narrations = needs.getRows(2, Math.max(needs.rowCount - 1, 1))!.map((x) => x.getCell(5).value);
    expect(narrations).not.toContain("NEFT-SYNTH0099-UNKNOWN PARTY-REF");
    const summary = wb.getWorksheet("Summary")!;
    const unexplained = summary.getRows(1, summary.rowCount)!
      .find((x) => String(x.getCell(1).value).startsWith("Unexplained credits"))!;
    expect(unexplained.getCell(2).value).toBe(0);
  });

  it("shows decisions in the workbook", async () => {
    const { ca, reference } = await prepared();
    await decide(ca, reference, 4, { category: "Business / Professional Expenses", note: "Office supplies" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await (await ca.get(workbookRoute, { params: { reference } })).arrayBuffer());
    const all = wb.getWorksheet("All Transactions")!;
    const rowFor = (narration: string) => all.getRows(2, all.rowCount - 1)!.find((x) => x.getCell(8).value === narration)!;
    expect(rowFor("UPI/RAHUL-MART").getCell(9).value).toBe("Business / Professional Expenses");
    expect(String(rowFor("UPI/RAHUL-MART").getCell(12).value)).toMatch(/^CA changed the category from Personal Expenses: Office supplies/);
    expect(wb.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(["Summary", "All Transactions", "Needs Review",
      "Business - Professional Expense", "Salary - Pension"]));
    expect(wb.worksheets.map((w) => w.name)).not.toContain("Dividend"); // nil categories get no sheet
    const summary = wb.getWorksheet("Summary")!;
    const cells = summary.getSheetValues().flat().map((v) => (v && typeof v === "object" && "formula" in v ? `=${v.formula}` : String(v ?? "")));
    expect(cells.some((v) => v.startsWith("=SUMIFS("))).toBe(true);
    expect(cells.some((v) => v.startsWith("1. Large unexplained credits (for CA verification)"))).toBe(true);
    expect(cells.some((v) => v.startsWith("This summary has been prepared only from the bank statement(s)"))).toBe(true);
    expect(String(summary.getCell("A3").value)).toMatch(/^UNVERIFIED/); // a rejected row keeps it unverified
  });

  it("is refused for bad input, closed cases, other firms, clients and cross-site requests", async () => {
    const { ca, client, reference } = await prepared();
    expect((await decide(ca, reference, 4, { category: "Lottery Winnings" })).status).toBe(400);
    expect((await decide(ca, reference, 4, { category: "Personal Expenses", note: "x".repeat(301) })).status).toBe(400);
    expect((await decide(ca, reference, 6, { category: "Personal Expenses" })).status).toBe(409); // a rejected row
    expect((await decide(ca, reference, 99, { category: "Personal Expenses" })).status).toBe(404);
    expect((await decide(client, reference, 4, { category: "Personal Expenses" })).status).toBe(401);
    expect((await decide(ca, reference, 4, { category: "Personal Expenses" }, { csrf: false })).status).toBe(403);
    const other = await onboardCa("b");
    expect((await decide(other, reference, 4, { category: "Personal Expenses" })).status).toBe(404);
    await env.db.query("UPDATE cases SET status = 'closed', closed_at = now()");
    expect((await decide(ca, reference, 4, { category: "Personal Expenses" })).status).toBe(409);
    expect(await rows("SELECT id FROM classification_corrections")).toEqual([]);
  });
});
