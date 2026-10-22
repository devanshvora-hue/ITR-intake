// The suggested document checklist: the rules themselves, and the stored
// suggestions, client answers and CA decisions through the real routes.
// Synthetic profiles and statements only.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as detailRoute } from "@/app/api/ca/cases/[reference]/route";
import { POST as refreshRoute } from "@/app/api/ca/cases/[reference]/checklist/route";
import { POST as caItemRoute } from "@/app/api/ca/cases/[reference]/checklist/[itemId]/route";
import { POST as reviewRoute } from "@/app/api/ca/cases/[reference]/review/route";
import { POST as createCode } from "@/app/api/ca/firm-code/route";
import { POST as openCase } from "@/app/api/client/cases/route";
import { POST as clientItemRoute } from "@/app/api/client/cases/[reference]/checklist/[itemId]/route";
import { POST as saveProfile } from "@/app/api/client/cases/[reference]/profile/route";
import { POST as statementRoute } from "@/app/api/client/cases/[reference]/statements/route";
import { GET as clientMe } from "@/app/api/client/me/route";
import { POST as start } from "@/app/api/client/start/route";
import type { CaChecklistItem, ClientChecklistItem } from "@/lib/checklist";
import { evaluateChecklist, type ChecklistFacts } from "@/lib/server/checklist";
import { financialYearOptions } from "@/lib/server/client-auth";
import { MemoryStore, setFileStoreForTests } from "@/lib/server/storage";
import { onboardCa } from "./helpers/ca";
import { Client, env, rows, setupTestServer } from "./helpers/http";

const facts = (declared: string[] = [], detected: Record<string, number> = {}): ChecklistFacts =>
  ({ financialYear: "2025-26", declared: new Set(declared), detected: new Map(Object.entries(detected)) });
const keys = (f: ChecklistFacts) => evaluateChecklist(f).map((s) => [s.key, s.level]);

describe("checklist rules", () => {
  it("give an empty profile one safe, optional general item", () => {
    expect(keys(facts())).toEqual([["other_bank_statements", "optional"]]);
  });

  it("differ by declared situation", () => {
    expect(keys(facts(["salary"]))).toEqual([["form_16", "required"], ["salary_slips", "optional"],
      ["other_bank_statements", "optional"]]);
    expect(keys(facts(["rental", "capital_gains"]))).toEqual([["capital_gains_statement", "required"],
      ["rental_records", "required"], ["municipal_tax_receipts", "optional"], ["other_bank_statements", "optional"]]);
    expect(keys(facts(["business"]))).toEqual([["business_records", "required"], ["other_bank_statements", "optional"]]);
  });

  it("treat statement activity alone as conditional, never likely", () => {
    const suggestions = evaluateChecklist(facts([], { "Salary / Pension": 12, "Interest – FD / RD / Others": 2,
      "Loan EMI / Repayment": 12, "Tax Payments": 1 }));
    expect(suggestions.map((s) => [s.key, s.level])).toEqual([["form_16", "conditional"], ["salary_slips", "optional"],
      ["deposit_interest_certificate", "conditional"], ["home_loan_certificate", "conditional"],
      ["tax_payment_challans", "conditional"], ["other_bank_statements", "optional"]]);
    expect(suggestions[0].evidence).toEqual([{ source: "statement", category: "Salary / Pension", rows: 12 }]);
    expect(suggestions[3].reason).toMatch(/Only if any of them are for a home loan/);
  });

  it("never make deductions more than conditional, even when declared", () => {
    const suggestions = evaluateChecklist(facts(["tax_saving"], { "Investments – Tax-saving": 3, "Insurance – Health": 1,
      Donations: 2 }));
    for (const key of ["tax_saving_proofs", "health_insurance_receipts", "donation_receipts"]) {
      expect(suggestions.find((s) => s.key === key)?.level).toBe("conditional");
    }
  });

  it("combine a declaration and matching activity into one item with both reasons on record", () => {
    const [form16] = evaluateChecklist(facts(["salary"], { "Salary / Pension": 3 }));
    expect([form16.key, form16.level]).toEqual(["form_16", "required"]);
    expect(form16.reason).toMatch(/^You told us/);
    expect(form16.evidence).toEqual([{ source: "profile", code: "salary" },
      { source: "statement", category: "Salary / Pension", rows: 3 }]);
  });

  it("ignore categories that say nothing about documents", () => {
    const everyday = { "Personal Expenses": 40, "Bank Charges": 3, "Self Transfer": 5, "Family Transfer": 2,
      "Cash Withdrawal": 4, "Credit Card Payments": 6, "Interest – Savings Bank": 4, "Others – Needs Review": 9 };
    expect(keys(facts([], everyday))).toEqual([["other_bank_statements", "optional"]]);
  });

  it("never repeat a key and mention the financial year", () => {
    const all = evaluateChecklist(facts(["salary", "rental", "capital_gains", "business", "home_loan", "tax_saving"], {
      "Salary / Pension": 1, "Rent Received": 1, "Sale / Redemption of Investments": 1, Dividend: 1,
      "Business / Professional Receipts": 1, "Loans Received / Repayment of Loans Given": 1,
      "Gifts / Receipts from Non-relatives": 1, "Investments – Tax-saving": 1 }));
    expect(new Set(all.map((s) => s.key)).size).toBe(all.length);
    expect(all.find((s) => s.key === "form_16")!.reason).toContain("FY 2025-26");
  });
});

setupTestServer();
let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  setFileStoreForTests(store);
});
afterEach(() => setFileStoreForTests(null));

const FY = financialYearOptions().includes("2025-26") ? "2025-26" : financialYearOptions()[0];
const CSV = new TextEncoder().encode("Date,Narration,Debit,Credit,Balance\n01/04/2025,UPI/1001/SYNTHETIC SHOP,250.00,,9750.00\n"
  + "02/04/2025,NEFT SALARY SYNTHETIC CO,,50000.00,59750.00\n");
const PROFILE = { full_name: "Asha Rao", bank_name: "Synthetic Bank Ltd", account_last4: "1234" };

async function setup(tag = "a", profile: Record<string, unknown> | null = PROFILE) {
  const ca = await onboardCa(tag);
  const code = (await (await ca.post(createCode)).json()).firm_code.code;
  const client = new Client();
  const email = `client-${tag}@example.test`;
  expect((await client.post(start, { firm_code: code, email })).status).toBe(200); // signs in directly
  const { reference } = (await (await client.post(openCase, { first_name: "Asha", financial_year: FY })).json()).case;
  if (profile) expect((await client.post(saveProfile, profile, { params: { reference } })).status).toBe(200);
  return { ca, client, reference };
}

const clientItems = async (client: Client): Promise<ClientChecklistItem[]> =>
  (await (await client.get(clientMe)).json()).cases[0].checklist;
const caItems = async (ca: Client, reference: string): Promise<CaChecklistItem[]> =>
  (await (await ca.get(detailRoute, { params: { reference } })).json()).checklist;
const answer = (client: Client, reference: string, itemId: string, body: Record<string, unknown>, extra = {}) =>
  client.post(clientItemRoute, body, { params: { reference, itemId }, ...extra });
const decide = (ca: Client, reference: string, itemId: string, action: string, extra = {}) =>
  ca.post(caItemRoute, { action }, { params: { reference, itemId }, ...extra });
const idOf = (items: { id: string; label: string }[], label: RegExp) => items.find((i) => label.test(i.label))!.id;
const uploadStatement = (client: Client, reference: string) => client.call(statementRoute, { method: "POST",
  params: { reference }, rawBody: CSV, headers: { "content-type": "text/csv", "x-upload-filename": "s.csv" } });

describe("stored checklist", () => {
  it("follows the client's declared situations without duplicates, keeping answers", async () => {
    const { client, reference } = await setup("a", { ...PROFILE, income_sources: ["salary", "home_loan"] });
    let items = await clientItems(client);
    expect(items.map((i) => [i.label, i.level])).toEqual([
      ["Form 16 from your employer", "required"], ["Home loan interest certificate from your lender", "required"],
      ["Salary slips", "optional"], ["Statements for your other bank accounts", "optional"]]);
    expect(items[0]).not.toHaveProperty("evidence"); // the client never sees the evidence

    const form16 = idOf(items, /Form 16/);
    const response = await answer(client, reference, form16, { response: "unavailable", note: " Employer  closed down " });
    expect(response.status).toBe(200);
    // Saving the profile again (same or changed) never duplicates items and keeps the answer.
    await client.post(saveProfile, { ...PROFILE, income_sources: ["home_loan", "salary", "salary"] },
      { params: { reference } });
    await client.post(saveProfile, { ...PROFILE, income_sources: ["salary", "home_loan"] }, { params: { reference } });
    expect(await rows("SELECT key FROM checklist_items ORDER BY key")).toEqual(
      ["form_16", "home_loan_certificate", "other_bank_statements", "salary_slips"].map((key) => ({ key })));
    items = await clientItems(client);
    expect(items.find((i) => i.id === form16)).toMatchObject({ response: "unavailable", note: "Employer closed down" });

    // Withdrawing a declaration hides the item; declaring it again brings back the same row and answer.
    await client.post(saveProfile, { ...PROFILE, income_sources: ["home_loan"] }, { params: { reference } });
    expect((await clientItems(client)).map((i) => i.label)).not.toContain("Form 16 from your employer");
    await client.post(saveProfile, { ...PROFILE, income_sources: ["salary", "home_loan"] }, { params: { reference } });
    expect((await clientItems(client)).find((i) => i.id === form16)?.response).toBe("unavailable");
    // Leaving the field out keeps the declaration.
    await client.post(saveProfile, PROFILE, { params: { reference } });
    expect((await clientItems(client)).map((i) => i.id)).toContain(form16);
    expect(await rows("SELECT id FROM document_requests")).toEqual([]); // suggestions are never requests by themselves
  });

  it("refuses unknown income situations and bad answers", async () => {
    const { client, reference } = await setup();
    const bad = await client.post(saveProfile, { ...PROFILE, income_sources: ["salary", "lottery"] }, { params: { reference } });
    expect([bad.status, (await bad.json()).fields]).toEqual([400, ["income_sources"]]);
    const id = (await clientItems(client))[0].id;
    expect((await answer(client, reference, id, { response: "unavailable", note: "x".repeat(301) })).status).toBe(400);
    expect((await answer(client, reference, id, { response: null, note: "stray note" })).status).toBe(400);
    expect((await answer(client, reference, id, { response: "maybe" })).status).toBe(422);
    expect((await answer(client, reference, "00000000-0000-4000-8000-000000000000", { response: "unavailable" })).status).toBe(404);
    const cleared = await answer(client, reference, id, { response: null });
    expect(cleared.status).toBe(200);
  });

  it("gives an incomplete profile the general item only", async () => {
    const { ca, reference } = await setup("a", null);
    expect((await ca.post(refreshRoute, {}, { params: { reference } })).status).toBe(200);
    expect((await caItems(ca, reference)).map((i) => i.key)).toEqual(["other_bank_statements"]);
  });

  it("adds conditional items from the prepared review, counting only confident rows", async () => {
    const { ca, client, reference } = await setup();
    await uploadStatement(client, reference);
    const [upload] = await rows<{ id: string }>("SELECT id FROM statement_uploads");
    expect((await ca.post(reviewRoute, { statement_id: upload.id }, { params: { reference } })).status).toBe(200);
    const items = await caItems(ca, reference);
    const form16 = items.find((i) => i.key === "form_16")!;
    expect(form16.level).toBe("conditional");
    expect(form16.evidence).toEqual([{ source: "statement", category: "Salary / Pension", rows: 1 }]);

    await env.db.query("UPDATE statement_rows SET confidence = 'low' WHERE category = 'Salary / Pension'");
    await ca.post(refreshRoute, {}, { params: { reference } });
    expect((await caItems(ca, reference)).map((i) => i.key)).toEqual(["other_bank_statements"]);
  });
});

describe("CA review of suggestions", () => {
  it("turns a suggestion into a real request only on the CA's request", async () => {
    const { ca, client, reference } = await setup("a", { ...PROFILE, income_sources: ["salary"] });
    await uploadStatement(client, reference);
    expect(await rows("SELECT id FROM document_requests")).toEqual([]);
    const items = await caItems(ca, reference);
    const form16 = idOf(items, /Form 16/);
    await answer(client, reference, idOf(items, /Salary slips/), { response: "not_applicable", note: "Paid in cash" });

    const response = await decide(ca, reference, form16, "request");
    expect(response.status).toBe(200);
    const [request] = await rows<{ key: string; label: string; source: string; required: boolean; status: string }>(
      "SELECT key, label, source, required, status FROM document_requests");
    expect(request).toEqual({ key: "checklist_form_16", label: "Form 16 from your employer", source: "rules", required: true,
      status: "requested" });
    expect((await rows<{ status: string }>("SELECT status FROM cases"))[0].status).toBe("documents_pending");

    // The client now sees it as a request, not a suggestion; the CA sees the client's answer on the other item.
    const me = (await (await client.get(clientMe)).json()).cases[0];
    expect(me.document_requests.map((r: { label: string }) => r.label)).toEqual(["Form 16 from your employer"]);
    expect(me.checklist.map((i: { label: string }) => i.label)).not.toContain("Form 16 from your employer");
    const after = await caItems(ca, reference);
    expect(after.find((i) => i.id === form16)).toMatchObject({ status: "requested" });
    expect(after.find((i) => /Salary slips/.test(i.label))).toMatchObject({ response: "not_applicable", note: "Paid in cash" });

    const again = await decide(ca, reference, form16, "request");
    expect([again.status, (await again.json()).error]).toEqual([409, "invalid_transition"]);
    expect(await rows("SELECT id FROM document_requests")).toHaveLength(1);
    // A refresh keeps the requested item linked and creates nothing new.
    await ca.post(refreshRoute, {}, { params: { reference } });
    expect(await rows("SELECT id FROM document_requests")).toHaveLength(1);
    expect(await rows("SELECT action FROM audit_events WHERE action LIKE 'checklist.%' ORDER BY created_at")).toEqual([
      { action: "checklist.client_responded" }, { action: "checklist.item_requested" }]);
  });

  it("dismisses and restores suggestions, and the client cannot answer dismissed ones", async () => {
    const { ca, client, reference } = await setup("a", { ...PROFILE, income_sources: ["rental"] });
    const id = idOf(await caItems(ca, reference), /Property tax/);
    expect((await decide(ca, reference, id, "dismiss")).status).toBe(200);
    expect((await clientItems(client)).map((i) => i.id)).not.toContain(id);
    const closed = await answer(client, reference, id, { response: "unavailable" });
    expect([closed.status, (await closed.json()).error]).toEqual([409, "item_closed"]);
    expect((await decide(ca, reference, id, "dismiss")).status).toBe(409);
    expect((await decide(ca, reference, id, "request")).status).toBe(409);
    expect((await decide(ca, reference, id, "restore")).status).toBe(200);
    expect((await clientItems(client)).map((i) => i.id)).toContain(id);
    expect((await decide(ca, reference, id, "fly")).status).toBe(422);
  });

  it("is refused on a closed case", async () => {
    const { ca, reference } = await setup("a", { ...PROFILE, income_sources: ["salary"] });
    const id = idOf(await caItems(ca, reference), /Form 16/);
    await env.db.query("UPDATE cases SET status = 'closed', closed_at = now()");
    const response = await decide(ca, reference, id, "request");
    expect([response.status, (await response.json()).error]).toEqual([409, "case_closed"]);
    expect((await ca.post(refreshRoute, {}, { params: { reference } })).status).toBe(409);
    expect(await rows("SELECT id FROM document_requests")).toEqual([]);
  });
});

describe("checklist access control", () => {
  it("keeps firms and clients apart and needs the right session and CSRF header", async () => {
    const a = await setup("a", { ...PROFILE, income_sources: ["salary"] });
    const b = await setup("b", { ...PROFILE, income_sources: ["salary"] });
    const itemA = idOf(await caItems(a.ca, a.reference), /Form 16/);

    expect((await decide(b.ca, a.reference, itemA, "request")).status).toBe(404);   // another firm's case
    expect((await decide(b.ca, b.reference, itemA, "request")).status).toBe(404);   // own case, another case's item
    expect((await b.ca.post(refreshRoute, {}, { params: { reference: a.reference } })).status).toBe(404);
    expect((await answer(b.client, a.reference, itemA, { response: "unavailable" })).status).toBe(404);
    expect((await answer(b.client, b.reference, itemA, { response: "unavailable" })).status).toBe(404);

    expect((await decide(a.client, a.reference, itemA, "request")).status).toBe(401);   // a client is not a CA
    expect((await answer(a.ca, a.reference, itemA, { response: "unavailable" })).status).toBe(401); // a CA is not a client
    expect((await decide(new Client(), a.reference, itemA, "request")).status).toBe(401);
    expect((await decide(a.ca, a.reference, itemA, "request", { csrf: false })).status).toBe(403);
    expect((await answer(a.client, a.reference, itemA, { response: "unavailable" }, { csrf: false })).status).toBe(403);

    expect(await rows("SELECT id FROM document_requests")).toEqual([]);
    expect(await rows("SELECT id FROM checklist_items WHERE client_response IS NOT NULL")).toEqual([]);
  });
});
