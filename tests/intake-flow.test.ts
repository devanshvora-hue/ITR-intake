// The whole demo journey through the real routes: a client enters with firm
// code + e-mail (no e-mail link), fills in the intake and uploads documents;
// the CA sees all of it on the dashboard and case page and downloads the file.
// Synthetic data only, in-memory storage.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as caCases } from "@/app/api/ca/cases/route";
import { GET as caseDetail } from "@/app/api/ca/cases/[reference]/route";
import { POST as caChecklistItem } from "@/app/api/ca/cases/[reference]/checklist/[itemId]/route";
import { GET as download } from "@/app/api/ca/cases/[reference]/documents/[documentId]/route";
import { POST as createCode } from "@/app/api/ca/firm-code/route";
import { POST as openCase } from "@/app/api/client/cases/route";
import { POST as clientChecklistItem } from "@/app/api/client/cases/[reference]/checklist/[itemId]/route";
import { POST as uploadDocument } from "@/app/api/client/cases/[reference]/document-requests/[requestId]/files/route";
import { POST as saveProfile } from "@/app/api/client/cases/[reference]/profile/route";
import { POST as uploadStatement } from "@/app/api/client/cases/[reference]/statements/route";
import { GET as clientMe } from "@/app/api/client/me/route";
import { POST as start } from "@/app/api/client/start/route";
import { financialYearOptions } from "@/lib/server/client-auth";
import { MemoryStore, setFileStoreForTests } from "@/lib/server/storage";
import { onboardCa } from "./helpers/ca";
import { Client, setupTestServer } from "./helpers/http";

setupTestServer();
beforeEach(() => setFileStoreForTests(new MemoryStore()));
afterEach(() => setFileStoreForTests(null));

const FY = financialYearOptions()[0];
const enc = (s: string) => new TextEncoder().encode(s);
const CSV = enc("Date,Narration,Debit,Credit,Balance\n01/04/2025,UPI/1001/SYNTHETIC SHOP,250.00,,9750.00\n");
const PDF = enc("%PDF-1.4\n% synthetic Form 16\n%%EOF\n");
type Step = { key: string; done: boolean };

describe("client submission reaches the CA", () => {
  it("shows the client's answers, uploads and progress on the CA dashboard and case page", async () => {
    const ca = await onboardCa("a");
    const code = (await (await ca.post(createCode)).json()).firm_code.code;

    // Client: enter, open the case, answer the questions, upload a statement.
    const client = new Client();
    expect((await client.post(start, { firm_code: code, email: "asha@example.test" })).status).toBe(200);
    const { reference } = (await (await client.post(openCase, { first_name: "Asha", financial_year: FY })).json()).case;
    let me = (await (await client.get(clientMe)).json()).cases[0];
    expect(me.intake.steps.map((s: Step) => [s.key, s.done])).toEqual([["details", false], ["statement", false],
      ["documents", true]]);
    expect((await client.post(saveProfile, { full_name: "Asha Rao", bank_name: "Synthetic Bank Ltd",
      income_sources: ["salary"] }, { params: { reference } })).status).toBe(200);
    expect((await client.call(uploadStatement, { method: "POST", params: { reference }, rawBody: CSV,
      headers: { "content-type": "text/csv", "x-upload-filename": "statement.csv" } })).status).toBe(201);

    // CA: the dashboard lists the client by name, e-mail and reference.
    let listed = (await (await ca.get(caCases)).json()).cases;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ reference, client_email: "asha@example.test", client_email_verified: false,
      profile: { full_name: "Asha Rao", income_sources: ["salary"] }, intake: { complete: true } });

    // CA requests Form 16 from the suggestions; the client's intake is now incomplete until it is uploaded.
    const checklist = (await (await ca.get(caseDetail, { params: { reference } })).json()).checklist;
    const form16 = checklist.find((i: { key: string }) => i.key === "form_16");
    const slips = checklist.find((i: { key: string }) => i.key === "salary_slips");
    expect((await ca.post(caChecklistItem, { action: "request" }, { params: { reference, itemId: form16.id } })).status).toBe(200);
    me = (await (await client.get(clientMe)).json()).cases[0];
    expect(me.intake.complete).toBe(false);
    expect(me.intake.steps.find((s: Step) => s.key === "documents")).toEqual({ key: "documents", done: false, outstanding: 1 });
    listed = (await (await ca.get(caCases)).json()).cases;
    expect(listed[0].intake.complete).toBe(false);

    // Client: upload the requested document and answer another suggestion.
    const request = me.document_requests[0];
    expect((await client.call(uploadDocument, { method: "POST", params: { reference, requestId: request.id }, rawBody: PDF,
      headers: { "content-type": "application/pdf", "x-upload-filename": "form16.pdf" } })).status).toBe(201);
    expect((await client.post(clientChecklistItem, { response: "not_applicable", note: "Paid as consultant" },
      { params: { reference, itemId: slips.id } })).status).toBe(200);

    // CA: everything is on the existing case page, and the file downloads through the secure route.
    const detail = await (await ca.get(caseDetail, { params: { reference } })).json();
    expect(detail.case).toMatchObject({ reference, client_email: "asha@example.test", client_email_verified: false,
      status: "statement_uploaded" });
    expect(detail.intake.complete).toBe(true);
    expect(detail.intake.last_client_upload_at).not.toBeNull();
    expect(detail.profile).toMatchObject({ full_name: "Asha Rao", bank_name: "Synthetic Bank Ltd", income_sources: ["salary"] });
    expect(detail.statements.map((s: { display_name: string }) => s.display_name)).toEqual(["statement.csv"]);
    expect(detail.document_requests[0]).toMatchObject({ label: "Form 16 from your employer", status: "received" });
    expect(detail.checklist.find((i: { key: string }) => i.key === "salary_slips"))
      .toMatchObject({ response: "not_applicable", note: "Paid as consultant" });
    const fileId = detail.document_requests[0].files[0].id;
    const file = await ca.get(download, { params: { reference, documentId: fileId } });
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);

    // Another firm sees none of it.
    const other = await onboardCa("b");
    expect((await (await other.get(caCases)).json()).cases).toEqual([]);
    expect((await other.get(caseDetail, { params: { reference } })).status).toBe(404);
    expect((await other.get(download, { params: { reference, documentId: fileId } })).status).toBe(404);
  });
});
