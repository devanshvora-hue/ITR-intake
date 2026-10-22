// Supporting-document requests, client uploads, CA downloads, waive/reopen and
// the case status that follows, through the real routes with in-memory
// storage. Synthetic files only.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as detailRoute } from "@/app/api/ca/cases/[reference]/route";
import { POST as createRoute } from "@/app/api/ca/cases/[reference]/document-requests/route";
import { POST as reopenRoute } from "@/app/api/ca/cases/[reference]/document-requests/[requestId]/reopen/route";
import { POST as waiveRoute } from "@/app/api/ca/cases/[reference]/document-requests/[requestId]/waive/route";
import { GET as downloadRoute } from "@/app/api/ca/cases/[reference]/documents/[documentId]/route";
import { POST as reviewRoute } from "@/app/api/ca/cases/[reference]/review/route";
import { POST as createCode } from "@/app/api/ca/firm-code/route";
import { POST as openCase } from "@/app/api/client/cases/route";
import { POST as saveProfile } from "@/app/api/client/cases/[reference]/profile/route";
import { POST as filesRoute } from "@/app/api/client/cases/[reference]/document-requests/[requestId]/files/route";
import { POST as statementRoute } from "@/app/api/client/cases/[reference]/statements/route";
import { GET as clientMe } from "@/app/api/client/me/route";
import { POST as start } from "@/app/api/client/start/route";
import { POST as verify } from "@/app/api/client/verify/route";
import { MAX_DOCUMENT_BYTES } from "@/lib/document-requests";
import { financialYearOptions } from "@/lib/server/client-auth";
import { MemoryStore, setFileStoreForTests } from "@/lib/server/storage";
import { onboardCa } from "./helpers/ca";
import { Client, env, mailedToken, rows, setupTestServer } from "./helpers/http";

setupTestServer();
let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  setFileStoreForTests(store);
});
afterEach(() => setFileStoreForTests(null));

const FY = financialYearOptions().includes("2025-26") ? "2025-26" : financialYearOptions()[0];
const enc = (s: string) => new TextEncoder().encode(s);
const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...enc(p)] : p)));
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "synthetic png body", "IEND", [0xae, 0x42, 0x60, 0x82]);
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], "synthetic jpeg body", [0xff, 0xd9]);
const PDF = enc("%PDF-1.4\n% synthetic supporting document\n%%EOF\n");
const CSV = enc("Date,Narration,Debit,Credit,Balance\n01/04/2025,UPI/1001/SYNTHETIC SHOP,250.00,,9750.00\n");

async function setup(tag = "a") {
  const ca = await onboardCa(tag);
  const code = (await (await ca.post(createCode)).json()).firm_code.code;
  const client = new Client();
  const email = `client-${tag}@example.test`;
  await client.post(start, { firm_code: code, email });
  await client.post(verify, { token: await mailedToken(email) });
  const { reference } = (await (await client.post(openCase, { first_name: "Asha", financial_year: FY })).json()).case;
  await client.post(saveProfile, { full_name: "Asha Rao", bank_name: "Synthetic Bank Ltd", account_last4: "1234" }, { params: { reference } });
  return { ca, client, reference };
}

const createRequest = (ca: Client, reference: string, body: Record<string, unknown> = { label: "Form 16 from employer" }, extra = {}) =>
  ca.post(createRoute, body, { params: { reference }, ...extra });
const waive = (ca: Client, reference: string, requestId: string, extra = {}) =>
  ca.post(waiveRoute, {}, { params: { reference, requestId }, ...extra });
const reopen = (ca: Client, reference: string, requestId: string) => ca.post(reopenRoute, {}, { params: { reference, requestId } });
const download = (ca: Client, reference: string, documentId: string) => ca.get(downloadRoute, { params: { reference, documentId } });
const caseStatus = async () => (await rows<{ status: string }>("SELECT status FROM cases"))[0].status;
const actions = async () => (await rows<{ action: string }>(
  "SELECT action FROM audit_events WHERE action LIKE 'document%' ORDER BY created_at")).map((r) => r.action);

function uploadFile(client: Client, reference: string, requestId: string, data: Uint8Array, name: string, type: string, extra = {}) {
  return client.call(filesRoute, { method: "POST", params: { reference, requestId }, rawBody: data,
    headers: { "content-type": type, "x-upload-filename": encodeURIComponent(name) }, ...extra });
}

async function newRequest(ca: Client, reference: string, body?: Record<string, unknown>): Promise<string> {
  const response = await createRequest(ca, reference, body);
  expect(response.status).toBe(201);
  return (await response.json()).request.id;
}

describe("document requests", () => {
  it("are created by the CA and listed for the CA (with file IDs) and the client (without)", async () => {
    const { ca, client, reference } = await setup();
    const response = await createRequest(ca, reference, { label: "  Form 16  from employer ", description: "Both pages", required: false });
    expect(response.status).toBe(201);
    const { request } = await response.json();
    expect(request).toMatchObject({ label: "Form 16 from employer", description: "Both pages", required: false,
      status: "requested", files: [] });
    const [stored] = await rows<{ key: string; source: string }>("SELECT key, source FROM document_requests");
    expect(stored.key).toMatch(/^form_16_from_employer_[0-9a-f]{6}$/);
    expect(stored.source).toBe("ca");

    await uploadFile(client, reference, request.id, PNG, "form16.png", "image/png");
    const caView = (await (await ca.get(detailRoute, { params: { reference } })).json()).document_requests;
    expect(caView[0].files[0]).toMatchObject({ display_name: "form16.png", content_type: "image/png" });
    expect(caView[0].files[0].id).toMatch(/^[0-9a-f-]{36}$/);
    const clientView = (await (await client.get(clientMe)).json()).cases[0].document_requests;
    expect(clientView[0].files[0]).not.toHaveProperty("id");
    expect(clientView[0].status).toBe("received");
    expect(await actions()).toEqual(["document_request.created", "document.uploaded"]);
  });

  it("validates the label and explanation", async () => {
    const { ca, reference } = await setup();
    for (const [body, field] of [[{ label: "x" }, "label"], [{ label: "   " }, "label"], [{ label: "a".repeat(121) }, "label"],
      [{ label: "Form 16", description: "d".repeat(501) }, "description"], [{ label: "Bad\u0000label" }, "label"]] as const) {
      const response = await createRequest(ca, reference, body);
      expect([response.status, (await response.json()).fields]).toEqual([400, [field]]);
    }
    expect((await createRequest(ca, reference, { label: "Form 16", key: "chosen" })).status).toBe(422); // unknown field
    expect(await rows("SELECT id FROM document_requests")).toHaveLength(0);
  });

  it("are refused on a closed case", async () => {
    const { ca, reference } = await setup();
    await env.db.query("UPDATE cases SET status = 'closed', closed_at = now()");
    const response = await createRequest(ca, reference);
    expect([response.status, (await response.json()).error]).toEqual([409, "case_closed"]);
  });
});

describe("client uploads", () => {
  it("accept PDF, JPEG and PNG, store them privately and mark the request received", async () => {
    const { ca, client, reference } = await setup();
    const id = await newRequest(ca, reference);
    for (const [data, name, type] of [[PDF, "a.pdf", "application/pdf"], [JPEG, "b.jpeg", "image/jpeg"], [PNG, "c.png", ""]] as const) {
      const response = await uploadFile(client, reference, id, data, name, type);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ created: true, document: { display_name: name, size_bytes: data.length } });
    }
    const docs = await rows<{ storage_key: string; firm_id: string; case_id: string; content_type: string }>(
      "SELECT storage_key, firm_id, case_id, content_type FROM documents ORDER BY created_at");
    expect(docs.map((d) => d.content_type)).toEqual(["application/pdf", "image/jpeg", "image/png"]);
    for (const d of docs) expect(d.storage_key.startsWith(`${d.firm_id}/${d.case_id}/`)).toBe(true);
    expect([...store.objects.keys()].sort()).toEqual(docs.map((d) => d.storage_key).sort());
    expect((await rows<{ status: string }>("SELECT status FROM document_requests"))[0].status).toBe("received");
  });

  it("returns the existing file for a repeat and refuses it for another request", async () => {
    const { ca, client, reference } = await setup();
    const first = await newRequest(ca, reference);
    const second = await newRequest(ca, reference, { label: "Rent receipts" });
    expect((await uploadFile(client, reference, first, PNG, "a.png", "image/png")).status).toBe(201);
    const repeat = await uploadFile(client, reference, first, PNG, "a.png", "image/png");
    expect([repeat.status, (await repeat.json()).created]).toEqual([200, false]);
    const other = await uploadFile(client, reference, second, PNG, "a.png", "image/png");
    expect([other.status, (await other.json()).error]).toEqual([409, "already_uploaded_for_another_request"]);
    expect(store.objects.size).toBe(1);
  });

  it("refuses bad files with fixed codes and stores nothing", async () => {
    const { ca, client, reference } = await setup();
    const id = await newRequest(ca, reference);
    const cases: [Uint8Array, string, string, number, string][] = [
      [new Uint8Array(0), "a.pdf", "application/pdf", 422, "empty_file"],
      [CSV, "a.csv", "text/csv", 422, "unsupported_file_type"],
      [enc("MZ synthetic"), "a.exe", "application/octet-stream", 422, "unsupported_file_type"],
      [PNG, "a.pdf", "application/pdf", 422, "type_mismatch"],        // PNG bytes named .pdf
      [PDF, "a.png", "image/png", 422, "type_mismatch"],              // PDF bytes named .png
      [PDF, "a.pdf", "text/html", 422, "type_mismatch"],              // declared type disagrees
      [PDF.subarray(0, 20), "a.pdf", "application/pdf", 422, "truncated_file"],
      [JPEG.subarray(0, JPEG.length - 2), "a.jpg", "image/jpeg", 422, "truncated_file"],
      [PNG.subarray(0, 12), "a.png", "image/png", 422, "truncated_file"],
    ];
    for (const [data, name, type, status, code] of cases) {
      const response = await uploadFile(client, reference, id, data, name, type);
      expect([name, response.status, (await response.json()).error]).toEqual([name, status, code]);
    }
    expect(await rows("SELECT id FROM documents")).toHaveLength(0);
    expect(store.objects.size).toBe(0);
    expect((await rows<{ status: string }>("SELECT status FROM document_requests"))[0].status).toBe("requested");
  });

  it("refuses files over the shared size limit", async () => {
    const { ca, client, reference } = await setup();
    const id = await newRequest(ca, reference);
    const big = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    big.set(PDF.subarray(0, 9));
    big.set(enc("%%EOF\n"), big.length - 6);
    const response = await uploadFile(client, reference, id, big, "big.pdf", "application/pdf");
    expect([response.status, (await response.json()).error]).toEqual([413, "file_too_large"]);
    const lying = await uploadFile(client, reference, id, PDF, "a.pdf", "application/pdf",
      { headers: { "content-type": "application/pdf", "content-length": String(MAX_DOCUMENT_BYTES + 1) } });
    expect(lying.status).toBe(413);
    expect(store.objects.size).toBe(0);
  });

  it("stops at five files per request", async () => {
    const { ca, client, reference } = await setup();
    const id = await newRequest(ca, reference);
    for (let i = 0; i < 5; i++) {
      const data = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `file ${i}`, "IEND");
      expect((await uploadFile(client, reference, id, data, `p${i}.png`, "image/png")).status).toBe(201);
    }
    const sixth = await uploadFile(client, reference, id, PNG, "p6.png", "image/png");
    expect([sixth.status, (await sixth.json()).error]).toEqual([409, "file_limit_reached"]);
  });

  it("are refused for waived requests and closed cases", async () => {
    const { ca, client, reference } = await setup();
    const id = await newRequest(ca, reference);
    await waive(ca, reference, id);
    const waived = await uploadFile(client, reference, id, PNG, "a.png", "image/png");
    expect([waived.status, (await waived.json()).error]).toEqual([409, "request_waived"]);
    await reopen(ca, reference, id);
    await env.db.query("UPDATE cases SET status = 'closed', closed_at = now()");
    const closed = await uploadFile(client, reference, id, PNG, "a.png", "image/png");
    expect([closed.status, (await closed.json()).error]).toEqual([409, "case_closed"]);
  });
});

describe("CA downloads", () => {
  it("return the exact bytes with safe headers and are audited", async () => {
    const { ca, client, reference } = await setup();
    const id = await newRequest(ca, reference);
    await uploadFile(client, reference, id, PDF, "Salary <slip>.pdf", "application/pdf");
    const [doc] = await rows<{ id: string }>("SELECT id FROM documents");
    const response = await download(ca, reference, doc.id);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${doc.id}.pdf"`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(await actions()).toContain("document.downloaded");
  });

  it("never serve bank statements, unknown IDs or missing files", async () => {
    const { ca, client, reference } = await setup();
    await client.call(statementRoute, { method: "POST", params: { reference }, rawBody: CSV,
      headers: { "content-type": "text/csv", "x-upload-filename": "s.csv" } });
    const [statement] = await rows<{ id: string }>("SELECT id FROM documents WHERE kind = 'bank_statement'");
    expect((await download(ca, reference, statement.id)).status).toBe(404);
    expect((await download(ca, reference, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await download(ca, reference, "not-an-id")).status).toBe(404);
    const id = await newRequest(ca, reference);
    await uploadFile(client, reference, id, PNG, "a.png", "image/png");
    const [doc] = await rows<{ id: string; storage_key: string }>("SELECT id, storage_key FROM documents WHERE kind = 'supporting'");
    store.objects.delete(doc.storage_key);
    expect((await download(ca, reference, doc.id)).status).toBe(404);
  });
});

describe("waive and reopen", () => {
  it("move requests between states and keep uploaded files", async () => {
    const { ca, client, reference } = await setup();
    const empty = await newRequest(ca, reference);
    const withFile = await newRequest(ca, reference, { label: "Rent receipts" });
    await uploadFile(client, reference, withFile, PNG, "a.png", "image/png");

    expect((await (await waive(ca, reference, empty)).json()).request.status).toBe("waived");
    expect((await (await reopen(ca, reference, empty)).json()).request.status).toBe("requested");
    expect((await (await waive(ca, reference, withFile)).json()).request.status).toBe("waived");
    const reopened = (await (await reopen(ca, reference, withFile)).json()).request;
    expect([reopened.status, reopened.files.length]).toEqual(["received", 1]);

    const again = await reopen(ca, reference, withFile);
    expect([again.status, (await again.json()).error]).toEqual([409, "invalid_transition"]);
    await waive(ca, reference, empty);
    const twice = await waive(ca, reference, empty);
    expect([twice.status, (await twice.json()).error]).toEqual([409, "invalid_transition"]);

    const audit = await rows<{ action: string; details_json: Record<string, string> }>(
      "SELECT action, details_json FROM audit_events WHERE action IN ('document_request.waived', 'document_request.reopened') ORDER BY created_at");
    expect(audit.map((a) => [a.action, a.details_json.from, a.details_json.to])).toEqual([
      ["document_request.waived", "requested", "waived"], ["document_request.reopened", "waived", "requested"],
      ["document_request.waived", "received", "waived"], ["document_request.reopened", "waived", "received"],
      ["document_request.waived", "requested", "waived"],
    ]);
  });

  it("are refused for unknown requests and closed cases", async () => {
    const { ca, reference } = await setup();
    const id = await newRequest(ca, reference);
    expect((await waive(ca, reference, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await waive(ca, reference, "nope")).status).toBe(404);
    await env.db.query("UPDATE cases SET status = 'closed', closed_at = now()");
    const response = await waive(ca, reference, id);
    expect([response.status, (await response.json()).error]).toEqual([409, "case_closed"]);
  });
});

describe("case status", () => {
  it("follows the statement, review and required document requests", async () => {
    const { ca, client, reference } = await setup();
    await newRequest(ca, reference, { label: "Optional extra", required: false });
    const required = await newRequest(ca, reference);
    expect(await caseStatus()).toBe("draft"); // no statement yet

    await client.call(statementRoute, { method: "POST", params: { reference }, rawBody: CSV,
      headers: { "content-type": "text/csv", "x-upload-filename": "s.csv" } });
    expect(await caseStatus()).toBe("documents_pending");

    const [upload] = await rows<{ id: string }>("SELECT id FROM statement_uploads");
    expect((await ca.post(reviewRoute, { statement_id: upload.id }, { params: { reference } })).status).toBe(200);
    expect(await caseStatus()).toBe("documents_pending"); // a required request is still outstanding

    await uploadFile(client, reference, required, PDF, "f16.pdf", "application/pdf");
    expect(await caseStatus()).toBe("review_ready");   // the optional request does not hold it back

    await waive(ca, reference, required);
    expect(await caseStatus()).toBe("review_ready");
    await reopen(ca, reference, required);             // it has a file, so it is "received" again
    expect(await caseStatus()).toBe("review_ready");

    await newRequest(ca, reference, { label: "Bank interest certificate" });
    expect(await caseStatus()).toBe("documents_pending");
    const [pending] = await rows<{ id: string }>("SELECT id FROM document_requests WHERE status = 'requested' AND required");
    await waive(ca, reference, pending.id);
    expect(await caseStatus()).toBe("review_ready");
  });

  it("returns to statement_uploaded when requests resolve before any review", async () => {
    const { ca, client, reference } = await setup();
    await client.call(statementRoute, { method: "POST", params: { reference }, rawBody: CSV,
      headers: { "content-type": "text/csv", "x-upload-filename": "s.csv" } });
    expect(await caseStatus()).toBe("statement_uploaded");
    const id = await newRequest(ca, reference);
    expect(await caseStatus()).toBe("documents_pending");
    await waive(ca, reference, id);
    expect(await caseStatus()).toBe("statement_uploaded");
  });
});

describe("access control", () => {
  it("needs the right session and CSRF header", async () => {
    const { ca, client, reference } = await setup();
    const id = await newRequest(ca, reference);
    await uploadFile(client, reference, id, PNG, "a.png", "image/png");
    const [doc] = await rows<{ id: string }>("SELECT id FROM documents");
    const anonymous = new Client();

    expect((await createRequest(client, reference)).status).toBe(401);      // a client is not a CA
    expect((await createRequest(anonymous, reference)).status).toBe(401);
    expect((await waive(client, reference, id)).status).toBe(401);
    expect((await download(client, reference, doc.id)).status).toBe(401);
    expect((await uploadFile(ca, reference, id, PDF, "a.pdf", "application/pdf")).status).toBe(401); // a CA is not a client
    expect((await uploadFile(anonymous, reference, id, PDF, "a.pdf", "application/pdf")).status).toBe(401);

    expect((await createRequest(ca, reference, { label: "Form 16" }, { csrf: false })).status).toBe(403);
    expect((await waive(ca, reference, id, { csrf: false })).status).toBe(403);
    expect((await uploadFile(client, reference, id, PDF, "a.pdf", "application/pdf", { csrf: false })).status).toBe(403);
    expect(await rows("SELECT id FROM document_requests")).toHaveLength(1);
    expect(await rows("SELECT id FROM documents")).toHaveLength(1);
  });

  it("keeps firms and clients apart", async () => {
    const a = await setup("a");
    const b = await setup("b");
    const requestA = await newRequest(a.ca, a.reference);
    await uploadFile(a.client, a.reference, requestA, PNG, "a.png", "image/png");
    const [docA] = await rows<{ id: string }>("SELECT id FROM documents");
    const requestB = await newRequest(b.ca, b.reference);

    // Another firm's CA: the case and everything in it are "not found".
    expect((await createRequest(b.ca, a.reference)).status).toBe(404);
    expect((await waive(b.ca, a.reference, requestA)).status).toBe(404);
    expect((await download(b.ca, a.reference, docA.id)).status).toBe(404);
    // Own case, but another case's request or document.
    expect((await waive(b.ca, b.reference, requestA)).status).toBe(404);
    expect((await download(b.ca, b.reference, docA.id)).status).toBe(404);
    // Another client's case, or own case with another case's request.
    expect((await uploadFile(b.client, a.reference, requestA, PDF, "x.pdf", "application/pdf")).status).toBe(404);
    expect((await uploadFile(b.client, b.reference, requestA, PDF, "x.pdf", "application/pdf")).status).toBe(404);
    expect((await uploadFile(a.client, a.reference, requestB, PDF, "x.pdf", "application/pdf")).status).toBe(404);

    expect(await rows("SELECT id FROM documents")).toHaveLength(1);
    expect((await rows<{ status: string }>("SELECT status FROM document_requests ORDER BY created_at")).map((r) => r.status))
      .toEqual(["received", "requested"]);
  });
});
