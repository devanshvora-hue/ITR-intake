// Follow-up checks: UPI direction and rule priority, self/family wording,
// stale CA decisions, dashboard-to-workbook consistency, verification status,
// and the suggested-document -> request -> upload -> download -> waive/reopen
// path. Synthetic data only.

import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as detailRoute } from "@/app/api/ca/cases/[reference]/route";
import { POST as checklistItem } from "@/app/api/ca/cases/[reference]/checklist/[itemId]/route";
import { POST as reopenRoute } from "@/app/api/ca/cases/[reference]/document-requests/[requestId]/reopen/route";
import { POST as waiveRoute } from "@/app/api/ca/cases/[reference]/document-requests/[requestId]/waive/route";
import { GET as downloadRoute } from "@/app/api/ca/cases/[reference]/documents/[documentId]/route";
import { POST as reviewRoute } from "@/app/api/ca/cases/[reference]/review/route";
import { POST as decideRoute } from "@/app/api/ca/cases/[reference]/review/rows/[rowNumber]/route";
import { GET as workbookRoute } from "@/app/api/ca/cases/[reference]/workbook/route";
import { POST as createCode } from "@/app/api/ca/firm-code/route";
import { POST as openCase } from "@/app/api/client/cases/route";
import { POST as uploadDocument } from "@/app/api/client/cases/[reference]/document-requests/[requestId]/files/route";
import { POST as saveProfile } from "@/app/api/client/cases/[reference]/profile/route";
import { POST as uploadStatement } from "@/app/api/client/cases/[reference]/statements/route";
import { GET as clientMe } from "@/app/api/client/me/route";
import { POST as start } from "@/app/api/client/start/route";
import type { ReviewRow } from "@/lib/case-review";
import { financialYearOptions } from "@/lib/server/client-auth";
import { MemoryStore, setFileStoreForTests } from "@/lib/server/storage";
import { classifyStatement, type ClientProfile } from "@/lib/statement/classifier";
import type { Transaction } from "@/lib/statement/validation";
import { onboardCa } from "./helpers/ca";
import { Client, env, rows, setupTestServer } from "./helpers/http";

let n = 0;
const txn = (narration: string, debit: number, credit = 0): Transaction => ({
  rowNumber: ++n, date: "2025-05-10", narration, debit: BigInt(Math.round(debit * 100)), credit: BigInt(Math.round(credit * 100)),
  balance: null, rawDebit: null, rawCredit: null, rawBalance: null,
});
const PROFILE: ClientProfile = { name: "Asha Rao" };
const one = (t: Transaction, p: ClientProfile = PROFILE) => classifyStatement([t], p)[0];
const triple = (t: Transaction, p?: ClientProfile) => {
  const c = one(t, p);
  return [c.category, c.reviewStatus, c.matchedRule];
};

describe("UPI direction and rule priority", () => {
  it("defaults outgoing UPI merchant payments to Personal Expenses, never incoming ones", () => {
    expect(triple(txn("UPI/P2M/512345678901/SYNTH BAKERY/Payment", 320))).toEqual(["Personal Expenses", "Auto-classified", "mode.upi_merchant"]);
    const incoming = one(txn("UPI/P2M/512345678901/SYNTH BAKERY/Refund adj", 0, 320));
    expect(incoming.category).not.toBe("Personal Expenses");
    const incomingP2P = one(txn("UPI/P2P/512311112222/SYNTH FRIEND/Split", 0, 450));
    expect([incomingP2P.category, incomingP2P.reviewStatus]).toEqual(["Others – Needs Review", "Needs review"]);
  });

  it("lets stronger evidence win over the UPI default", () => {
    expect(triple(txn("UPI/LIC OF INDIA PREMIUM", 24150))[0]).toBe("Investments – Tax-saving");
    expect(triple(txn("UPI/NACH MUTUAL FUND SIP/DEMO AMC", 5000))[0]).toBe("Investments – Others");
    expect(triple(txn("UPI/ACH/SYNTH HOME LOAN EMI", 32450))[0]).toBe("Loan EMI / Repayment");
    expect(triple(txn("UPI/ITNS 280 ADVANCE TAX", 15000))[0]).toBe("Tax Payments");
    expect(triple(txn("UPI/SYNTH TRUST DONATION", 2000))[0]).toBe("Donations");
    expect(triple(txn("UPI/SELF TRANSFER/HDFC", 10000))[0]).toBe("Self Transfer");
    expect(triple(txn("UPI/TRANSFER TO FATHER", 10000))[0]).toBe("Family Transfer");
  });
});

describe("self and family transfer wording", () => {
  it("recognises explicit wording, provisionally", () => {
    for (const [narration, category] of [
      ["NEFT TRANSFER FROM FAMILY", "Family Transfer"], ["FAMILY TRANSFER", "Family Transfer"], ["IMPS FAMILY TRF", "Family Transfer"],
      ["NEFT FROM FATHER", "Family Transfer"], ["IMPS FROM MOTHER", "Family Transfer"], ["SELF TRANSFER", "Self Transfer"],
      ["OWN ACCOUNT TRF", "Self Transfer"], ["TRANSFER TO OWN ACCOUNT XX1234", "Self Transfer"], ["IMPS TO SELF", "Self Transfer"],
    ] as const) {
      const c = one(txn(narration, 0, 5000));
      expect([narration, c.category, c.reviewStatus]).toEqual([narration, category, "Needs confirmation"]);
    }
  });

  it("does not treat every TRANSFER as self or family, and keeps contradicted ownership for review", () => {
    for (const narration of ["NEFT TRANSFER SYNTH TRADING CO", "IMPS TRANSFER 512399991111", "BY TRANSFER-REF 778899"]) {
      const c = one(txn(narration, 0, 75000));
      expect([narration, c.category]).toEqual([narration, "Others – Needs Review"]);
    }
    // "Own account" next to a name that only resembles the client's (MEHTANI vs MEHTA) is not established.
    expect(one(txn("NEFT DR-HDFC0000789-ARJUN MEHTANI-OWN AC", 5000), { name: "Arjun Mehta" }).category).toBe("Others – Needs Review");
    // Rules about the client still come first: a listed family member wins over generic wording.
    const p: ClientProfile = { name: "Asha Rao", familyMembers: [{ name: "Ravi Rao", relation: "spouse" }] };
    expect(triple(txn("NEFT FROM FATHER RAVI RAO", 0, 5000), p)).toEqual(["Family Transfer", "Auto-classified", "family.name"]);
    // "Self assessment tax" and "cash deposit by self" are not self transfers.
    expect(one(txn("SELF ASSESSMENT TAX CHALLAN", 9000)).category).toBe("Tax Payments");
    expect(one(txn("CASH DEPOSIT BY SELF", 0, 9000)).category).toBe("Cash Deposit");
  });
});

// --- through the routes ------------------------------------------------------------------------------------------

setupTestServer();
let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  setFileStoreForTests(store);
});
afterEach(() => setFileStoreForTests(null));

const FY = financialYearOptions().includes("2025-26") ? "2025-26" : financialYearOptions()[0];
const statementCsv = (lines: string[]) => new TextEncoder().encode(["Date,Narration,Debit,Credit,Balance", ...lines].join("\n") + "\n");
const GOOD = statementCsv([
  "01/04/2025,NEFT SALARY/DEMO SYSTEMS PVT LTD,,85000.00,185000.00",
  "02/04/2025,UPI/MAHARASHTRA ELECTRICITY,2340.00,,182660.00",
  "03/04/2025,NEFT-SYNTH0099-UNKNOWN PARTY-REF,,60000.00,242660.00",
  "04/04/2025,UPI/RAHUL-MART,640.00,,242020.00",
  "05/04/2025,CREDIT INTEREST,,312.40,242332.40",
  "06/04/2025,UPI/P2A/512300001112/VIKRAM SYNTH/Dinner,850.00,,241482.40",
]);

async function caseWith(csv: Uint8Array, tag = "a", profile: Record<string, unknown> = {}) {
  const ca = await onboardCa(tag);
  const code = (await (await ca.post(createCode)).json()).firm_code.code;
  const client = new Client();
  await client.post(start, { firm_code: code, email: `client-${tag}@example.test` });
  const { reference } = (await (await client.post(openCase, { first_name: "Asha", financial_year: FY })).json()).case;
  await client.post(saveProfile, { full_name: "Asha Rao", bank_name: "Synthetic Bank Ltd", ...profile }, { params: { reference } });
  const up = await client.call(uploadStatement, { method: "POST", params: { reference }, rawBody: csv,
    headers: { "content-type": "text/csv", "x-upload-filename": "s.csv" } });
  const statementId = (await up.json()).statement.id;
  expect((await ca.post(reviewRoute, { statement_id: statementId }, { params: { reference } })).status).toBe(200);
  return { ca, client, reference, statementId };
}
const detail = async (ca: Client, reference: string) => (await ca.get(detailRoute, { params: { reference } })).json();
const decide = (ca: Client, reference: string, row: number, body: Record<string, unknown>) =>
  ca.post(decideRoute, body, { params: { reference, rowNumber: String(row) } });
async function workbook(ca: Client, reference: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await (await ca.get(workbookRoute, { params: { reference } })).arrayBuffer());
  return wb;
}

describe("stale CA decisions", () => {
  it("puts a row whose decision no longer matches back in the queue, on the page and in the workbook", async () => {
    const { ca, reference } = await caseWith(GOOD);
    await decide(ca, reference, 2, { category: "Business / Professional Expenses" });
    await env.db.query("UPDATE statement_rows SET raw_narration = 'UPI/MAHARASHTRA ELECTRICITY BOARD' WHERE row_number = 2");
    const { review } = await detail(ca, reference);
    const row = review.rows.find((r: ReviewRow) => r.row_number === 2);
    expect([row.category, row.group, row.decision, row.stale_decision?.category])
      .toEqual(["Personal Expenses", "confirm", null, "Business / Professional Expenses"]);
    expect(review.totals.stale_decisions).toBe(1);
    const wb = await workbook(ca, reference);
    const needs = wb.getWorksheet("Needs Review")!;
    const reasons = needs.getRows(2, needs.rowCount - 1)!.map((r) => String(r.getCell(10).value));
    expect(reasons.some((r) => r.includes("earlier CA decision (Business / Professional Expenses) no longer matches"))).toBe(true);
  });
});

describe("dashboard and workbook consistency", () => {
  it("gives the same category totals, flags and review queue, before and after a decision", async () => {
    const { ca, reference } = await caseWith(GOOD);
    const check = async () => {
      const { review } = await detail(ca, reference);
      const wb = await workbook(ca, reference);
      const all = wb.getWorksheet("All Transactions")!;
      const totals = new Map<string, [number, number, number]>();
      for (const r of all.getRows(2, all.rowCount - 1)!) {
        const cat = String(r.getCell(9).value);
        const [count, debit, credit] = totals.get(cat) ?? [0, 0, 0];
        totals.set(cat, [count + 1, debit + Number(r.getCell(5).value ?? 0), credit + Number(r.getCell(6).value ?? 0)]);
      }
      for (const c of review.itr.categories.filter((x: { count: number }) => x.count)) {
        expect([c.category, ...totals.get(c.category)!]).toEqual([c.category, c.count, Number(c.debit), Number(c.credit)]);
      }
      expect(totals.size).toBe(review.itr.categories.filter((x: { count: number }) => x.count).length);
      // The workbook's review sheet lists exactly the rows the dashboard queue shows.
      const needs = wb.getWorksheet("Needs Review")!;
      const sheetRows = needs.getRows(2, Math.max(needs.rowCount - 1, 1))!.map((r) => r.getCell(1).value).filter((v) => typeof v === "number");
      const queue = review.rows.filter((r: ReviewRow) => r.group === "confirm" || r.group === "manual").map((r: ReviewRow) => r.row_number);
      expect([...sheetRows].sort()).toEqual([...queue].sort());
      // Every dashboard flag is a workbook note.
      const summary = wb.getWorksheet("Summary")!.getSheetValues().flat().map((v) => String(v ?? ""));
      for (const f of review.itr.flags) expect(summary.some((v) => v.includes(`${f.title} (for CA verification)`))).toBe(true);
      return review;
    };
    const before = await check();
    expect(before.itr.flags.map((f: { code: string }) => f.code)).toContain("unexplained_credits");
    await decide(ca, reference, 3, { category: "Business / Professional Receipts", note: "Consulting fee" });
    const after = await check();
    expect(after.itr.flags.map((f: { code: string }) => f.code)).not.toContain("unexplained_credits");
    expect(after.itr.categories.find((c: { category: string }) => c.category === "Business / Professional Receipts").credit).toBe("60000.00");
  });

  it("keeps a statement unverified when only the balance check passes", async () => {
    // A row repeated across a page break: the balances still add up overall, but extraction needs review.
    const csv = statementCsv(["01/04/2025,UPI/RAHUL-MART,640.00,,9360.00", "01/04/2025,UPI/RAHUL-MART,640.00,,9360.00",
      "02/04/2025,CREDIT INTEREST,,640.00,10000.00"]);
    const { ca, reference } = await caseWith(csv);
    const { review } = await detail(ca, reference);
    expect([review.statement.status, review.verified]).toEqual(["manual_review_required", false]);
    expect(review.unverified_reasons).toContain("statement_needs_manual_review");
    const wb = await workbook(ca, reference);
    expect(String(wb.getWorksheet("Summary")!.getCell("A3").value)).toMatch(/^UNVERIFIED/);
  });
});

describe("supporting-document workflow end to end", () => {
  it("requests a suggestion, takes the client's upload, downloads it and waives/reopens with accurate statuses", async () => {
    const { ca, client, reference } = await caseWith(GOOD, "a", { income_sources: ["salary"] });
    const suggestion = (await detail(ca, reference)).checklist.find((i: { key: string }) => i.key === "form_16");
    expect(suggestion.status).toBe("suggested");
    expect(await rows("SELECT id FROM document_requests")).toEqual([]); // a suggestion is not a request
    await ca.post(checklistItem, { action: "request" }, { params: { reference, itemId: suggestion.id } });

    let mine = (await (await client.get(clientMe)).json()).cases[0];
    expect(mine.document_requests.map((r: { label: string; required: boolean; status: string }) => [r.label, r.required, r.status]))
      .toEqual([["Form 16 from your employer", true, "requested"]]);
    const requestId = mine.document_requests[0].id;
    const pdf = new TextEncoder().encode("%PDF-1.4\n% synthetic form 16\n%%EOF\n");
    const bad = await client.call(uploadDocument, { method: "POST", params: { reference, requestId },
      rawBody: new TextEncoder().encode("not a pdf"), headers: { "content-type": "application/pdf", "x-upload-filename": "f16.pdf" } });
    expect([bad.status, (await bad.json()).error]).toEqual([422, "type_mismatch"]); // a visible, specific reason
    expect((await client.call(uploadDocument, { method: "POST", params: { reference, requestId }, rawBody: pdf,
      headers: { "content-type": "application/pdf", "x-upload-filename": "f16.pdf" } })).status).toBe(201);

    mine = (await (await client.get(clientMe)).json()).cases[0]; // a reload shows the new state
    expect(mine.document_requests[0].status).toBe("received");
    const caView = (await detail(ca, reference)).document_requests[0];
    const file = await ca.get(downloadRoute, { params: { reference, documentId: caView.files[0].id } });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(pdf);

    await ca.post(waiveRoute, {}, { params: { reference, requestId } });
    expect((await (await client.get(clientMe)).json()).cases[0].document_requests[0].status).toBe("waived");
    await ca.post(reopenRoute, {}, { params: { reference, requestId } });
    expect((await (await client.get(clientMe)).json()).cases[0].document_requests[0].status).toBe("received");
    expect((await rows<{ action: string }>("SELECT action FROM audit_events WHERE action LIKE 'document%' OR action LIKE 'checklist%' ORDER BY created_at"))
      .map((a) => a.action)).toEqual(["checklist.item_requested", "document.uploaded", "document.downloaded",
      "document_request.waived", "document_request.reopened"]);

    // Another firm sees none of it.
    const other = await onboardCa("b");
    expect((await other.get(downloadRoute, { params: { reference, documentId: caView.files[0].id } })).status).toBe(404);
    expect((await other.post(waiveRoute, {}, { params: { reference, requestId } })).status).toBe(404);
    expect(store.objects.size).toBe(2); // the statement and the one accepted document
  });
});
