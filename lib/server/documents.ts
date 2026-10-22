// CA document requests and client supporting-document uploads (ported from
// document_requests.py), plus the case status that follows from them.
//
// A CA asks for a document on one case; the owning client uploads PDF, JPEG
// or PNG files to that request. Files go to private storage under
// "<firm>/<case>/<document>.<ext>" as `documents` rows of kind 'supporting'
// linked to the request. Extension, declared content type and the file's real
// signature must agree; empty, oversized, truncated and malformed files are
// refused and never stored. The document row, request status, case status and
// audit event are written in one transaction; if that fails the stored file
// is removed. Nothing here logs file contents, names or storage keys.

import { MAX_DOCUMENT_BYTES, MAX_FILES_PER_REQUEST } from "../document-requests";
import { recordAudit } from "./audit";
import { syncCaseStatus } from "./case-status";
import type { CaseRow } from "./client-auth";
import type { Db } from "./db";
import { Conflict, guarded } from "./errors";
import { isId, newId, sha256Hex } from "./ids";
import { sanitiseDisplayName } from "./statements";
import { checkKey, StorageError, storageKey, type FileStore } from "./storage";

export { MAX_DOCUMENT_BYTES, MAX_FILES_PER_REQUEST };
export const LABEL_MIN = 2, LABEL_MAX = 120, DESCRIPTION_MAX = 500;

// extension in the file name -> stored extension, canonical content type, accepted declared types
const JPEG_TYPES = new Set(["", "image/jpeg", "image/jpg", "image/pjpeg", "application/octet-stream"]);
const TYPES: Record<string, [string, string, Set<string>]> = {
  pdf: ["pdf", "application/pdf", new Set(["", "application/pdf", "application/x-pdf", "application/octet-stream"])],
  jpg: ["jpg", "image/jpeg", JPEG_TYPES],
  jpeg: ["jpg", "image/jpeg", JPEG_TYPES],
  png: ["png", "image/png", new Set(["", "image/png", "application/octet-stream"])],
};

export type RequestRow = { id: string; case_id: string; firm_id: string; label: string; description: string | null;
  required: boolean; status: "requested" | "received" | "waived"; created_at: Date };
type DocumentRow = { id: string; request_id: string | null; kind: string; status: string; storage_key: string;
  display_name: string; content_type: string; size_bytes: number; created_at: Date };

/** A refused action; `code` is a fixed, safe string and nothing was changed. */
export class DocumentRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DocumentRefused";
  }
}

export class RequestInvalid extends Error {
  constructor(readonly fields: string[]) {
    super("invalid request");
    this.name = "RequestInvalid";
  }
}

// --- requests -----------------------------------------------------------------------------------

function clean(text: unknown, maxLen: number): string | null {
  if (text === null || text === undefined) return null;
  if (typeof text !== "string") throw new TypeError();
  const value = text.replace(/\s+/g, " ").trim();
  if (/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u.test(value) || value.length > maxLen) throw new RangeError();
  return value || null;
}

async function requestById(db: Db, firmId: string, caseId: string, requestId: unknown, lock = false): Promise<RequestRow | null> {
  if (!isId(requestId)) return null;
  const [row] = await db.query<RequestRow>(
    `SELECT * FROM document_requests WHERE id = $1 AND case_id = $2 AND firm_id = $3${lock ? " FOR UPDATE" : ""}`,
    [requestId, caseId, firmId]);
  return row ?? null;
}

/**
 * Create a CA request on a case of the caller's firm. The key is generated
 * here (slug of the label and a random suffix), never taken from the browser.
 * Throws RequestInvalid (field names only) or DocumentRefused("case_closed").
 */
export async function createRequest(db: Db, input: { firmId: string; caseRow: CaseRow; actorId: string;
  label: unknown; description: unknown; required: boolean }): Promise<RequestRow> {
  const { firmId, caseRow } = input;
  if (caseRow.status === "closed") throw new DocumentRefused("case_closed");
  const bad: string[] = [];
  let label: string | null = null, description: string | null = null;
  try {
    label = clean(input.label, LABEL_MAX);
    if (label === null || label.length < LABEL_MIN) bad.push("label");
  } catch {
    bad.push("label");
  }
  try {
    description = clean(input.description, DESCRIPTION_MAX);
  } catch {
    bad.push("description");
  }
  if (bad.length) throw new RequestInvalid(bad);
  const slug = label!.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "document";
  const key = `${slug}_${newId().replace(/-/g, "").slice(0, 6)}`;
  return guarded(() => db.transaction(async (tx) => {
    const [row] = await tx.query<RequestRow>(
      `INSERT INTO document_requests (case_id, firm_id, key, label, description, required, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'ca') RETURNING *`,
      [caseRow.id, firmId, key, label, description, input.required]);
    await recordAudit(tx, { actorKind: "ca", actorId: input.actorId, firmId, caseId: caseRow.id,
      action: "document_request.created", details: { request_id: row.id, required: input.required } });
    await syncCaseStatus(tx, firmId, caseRow.id);
    return row;
  }), "document_request");
}

/**
 * CA waive / reopen. waive: requested|received -> waived (files stay stored).
 * reopen: waived -> received if the request already has files, else requested,
 * so an outstanding request never holds uploads. Returns null for a request
 * outside the case; throws DocumentRefused("case_closed" | "invalid_transition").
 */
export async function changeRequestStatus(db: Db, input: { firmId: string; caseRow: CaseRow; actorId: string;
  requestId: unknown; action: "waive" | "reopen" }): Promise<RequestRow | null> {
  const { firmId, caseRow } = input;
  return db.transaction(async (tx) => {
    const request = await requestById(tx, firmId, caseRow.id, input.requestId, true);
    if (!request) return null;
    if (caseRow.status === "closed") throw new DocumentRefused("case_closed");
    let target: RequestRow["status"];
    if (input.action === "waive") {
      if (request.status === "waived") throw new DocumentRefused("invalid_transition");
      target = "waived";
    } else {
      if (request.status !== "waived") throw new DocumentRefused("invalid_transition");
      const [{ n }] = await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM documents WHERE request_id = $1 AND case_id = $2 AND firm_id = $3 AND status = 'stored'",
        [request.id, caseRow.id, firmId]);
      target = n > 0 ? "received" : "requested";
    }
    const [updated] = await tx.query<RequestRow>(
      "UPDATE document_requests SET status = $4, updated_at = now() WHERE id = $1 AND case_id = $2 AND firm_id = $3 RETURNING *",
      [request.id, caseRow.id, firmId, target]);
    await recordAudit(tx, { actorKind: "ca", actorId: input.actorId, firmId, caseId: caseRow.id,
      action: `document_request.${input.action === "waive" ? "waived" : "reopened"}`,
      details: { request_id: request.id, from: request.status, to: target } });
    await syncCaseStatus(tx, firmId, caseRow.id);
    return updated;
  });
}

/** One request with its files, in the shape of documentRequestViews. */
export async function requestView(db: Db, firmId: string, request: RequestRow, forCa: boolean) {
  const files = await db.query<DocumentRow>(
    `SELECT * FROM documents WHERE request_id = $1 AND case_id = $2 AND firm_id = $3 AND kind = 'supporting'
     ORDER BY created_at`, [request.id, request.case_id, firmId]);
  return {
    id: request.id, label: request.label, description: request.description, required: request.required,
    status: request.status, created_at: request.created_at,
    files: files.map((f) => ({ ...(forCa ? { id: f.id } : {}), display_name: f.display_name,
      content_type: f.content_type, size_bytes: f.size_bytes, uploaded_at: f.created_at })),
  };
}

// --- uploads ------------------------------------------------------------------------------------

function startsWith(data: Uint8Array, bytes: number[]): boolean {
  return data.length >= bytes.length && bytes.every((b, i) => data[i] === b);
}

function tailIncludes(data: Uint8Array, tail: number, bytes: number[]): boolean {
  const from = Math.max(0, data.length - tail);
  outer: for (let i = from; i <= data.length - bytes.length; i++) {
    for (let j = 0; j < bytes.length; j++) if (data[i + j] !== bytes[j]) continue outer;
    return true;
  }
  return false;
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** [stored extension, canonical content type] for an acceptable file; DocumentRefused otherwise. */
export function checkDocument(data: Uint8Array, filename: unknown, contentType: unknown): [string, string] {
  const m = /\.([A-Za-z0-9]{1,8})\s*$/.exec(typeof filename === "string" ? filename : "");
  const ext = m ? m[1].toLowerCase() : "";
  if (!data.length) throw new DocumentRefused("empty_file");
  if (!(ext in TYPES)) throw new DocumentRefused("unsupported_file_type");
  const [stored, canonical, accepted] = TYPES[ext];
  const declared = (typeof contentType === "string" ? contentType : "").split(";")[0].trim().toLowerCase();
  if (!accepted.has(declared)) throw new DocumentRefused("type_mismatch");
  if (data.length > MAX_DOCUMENT_BYTES) throw new DocumentRefused("file_too_large");
  if (stored === "pdf") {
    if (!startsWith(data, ascii("%PDF-"))) throw new DocumentRefused("type_mismatch");
    if (!tailIncludes(data, 2048, ascii("%%EOF"))) throw new DocumentRefused("truncated_file");
  } else if (stored === "jpg") {
    if (!startsWith(data, [0xff, 0xd8, 0xff])) throw new DocumentRefused("type_mismatch");
    if (!tailIncludes(data, 1024, [0xff, 0xd9])) throw new DocumentRefused("truncated_file");
  } else {
    if (!startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) throw new DocumentRefused("type_mismatch");
    if (!tailIncludes(data, 64, ascii("IEND"))) throw new DocumentRefused("truncated_file");
  }
  return [stored, canonical];
}

async function supportingByHash(db: Db, firmId: string, caseId: string, digest: string): Promise<DocumentRow | null> {
  const [row] = await db.query<DocumentRow>(
    "SELECT * FROM documents WHERE case_id = $1 AND firm_id = $2 AND kind = 'supporting' AND sha256 = $3",
    [caseId, firmId, digest]);
  return row ?? null;
}

export function documentView(d: DocumentRow) {
  return { display_name: d.display_name, content_type: d.content_type, size_bytes: d.size_bytes, uploaded_at: d.created_at };
}

/**
 * Store one supporting document for a request of the client's own case.
 * Returns null for a request outside the case; throws DocumentRefused.
 * `created` is false when the same file was already stored for this request.
 */
export async function handleDocumentUpload(db: Db, store: FileStore, input: { firmId: string; caseRow: CaseRow;
  requestId: unknown; actorId: string; data: Uint8Array; filename: unknown; contentType: unknown;
}): Promise<{ document: DocumentRow; created: boolean } | null> {
  const { firmId, caseRow, data } = input;
  const request = await requestById(db, firmId, caseRow.id, input.requestId);
  if (!request) return null;
  if (caseRow.status === "closed") throw new DocumentRefused("case_closed");
  if (request.status === "waived") throw new DocumentRefused("request_waived");
  const [ext, contentType] = checkDocument(data, input.filename, input.contentType);

  const digest = sha256Hex(data);
  const sameFile = async () => {
    const existing = await supportingByHash(db, firmId, caseRow.id, digest);
    if (!existing) return null;
    if (existing.request_id !== request.id) throw new DocumentRefused("already_uploaded_for_another_request");
    return { document: existing, created: false };
  };
  const repeat = await sameFile();
  if (repeat) return repeat;

  const documentId = newId();
  const key = storageKey(firmId, caseRow.id, documentId, ext);
  await store.put(key, data, contentType);
  try {
    const document = await guarded(() => db.transaction(async (tx) => {
      // The lock serialises uploads to one request, so the file limit and status checks hold.
      const locked = await requestById(tx, firmId, caseRow.id, request.id, true);
      if (!locked) throw new DocumentRefused("not_found");
      if (locked.status === "waived") throw new DocumentRefused("request_waived");
      const [{ n }] = await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM documents WHERE request_id = $1 AND case_id = $2 AND firm_id = $3",
        [request.id, caseRow.id, firmId]);
      if (n >= MAX_FILES_PER_REQUEST) throw new DocumentRefused("file_limit_reached");
      const [row] = await tx.query<DocumentRow>(
        `INSERT INTO documents (id, case_id, firm_id, request_id, kind, storage_key, display_name, content_type,
                                size_bytes, sha256, uploaded_by)
         VALUES ($1, $2, $3, $4, 'supporting', $5, $6, $7, $8, $9, 'client') RETURNING *`,
        [documentId, caseRow.id, firmId, request.id, key, sanitiseDisplayName(input.filename), contentType, data.length,
          digest]);
      if (locked.status === "requested") {
        await tx.query("UPDATE document_requests SET status = 'received', updated_at = now() WHERE id = $1 AND firm_id = $2",
          [request.id, firmId]);
      }
      await recordAudit(tx, { actorKind: "client", actorId: input.actorId, firmId, caseId: caseRow.id,
        action: "document.uploaded", details: { request_id: request.id, document_id: documentId } });
      await syncCaseStatus(tx, firmId, caseRow.id);
      return row;
    }), "document");
    return { document, created: true };
  } catch (error) {
    await store.remove(key).catch(() => undefined);
    if (error instanceof DocumentRefused && error.code === "not_found") return null;
    if (error instanceof Conflict && error.code === "duplicate_document") {
      const again = await sameFile(); // a concurrent identical upload
      if (again) return again;
    }
    throw error;
  }
}

/**
 * A stored supporting document of the CA's own case, with its bytes; null for
 * anything else (other case or firm, bank statements, workbooks, unknown IDs)
 * and for a missing or unreadable file. Records the download.
 */
export async function loadSupportingFile(db: Db, store: FileStore, input: { firmId: string; caseRow: CaseRow;
  documentId: unknown; actorId: string }): Promise<{ document: DocumentRow; data: Uint8Array } | null> {
  const { firmId, caseRow } = input;
  if (!isId(input.documentId)) return null;
  const [document] = await db.query<DocumentRow>(
    `SELECT * FROM documents WHERE id = $1 AND case_id = $2 AND firm_id = $3 AND kind = 'supporting'
       AND request_id IS NOT NULL AND status = 'stored'`, [input.documentId, caseRow.id, firmId]);
  if (!document) return null;
  let data: Uint8Array;
  try {
    checkKey(document.storage_key);
    data = await store.get(document.storage_key);
  } catch (error) {
    if (!(error instanceof StorageError)) throw error;
    console.error("supporting document unreadable", document.id, error.code);
    return null;
  }
  await recordAudit(db, { actorKind: "ca", actorId: input.actorId, firmId, caseId: caseRow.id, action: "document.downloaded",
    details: { document_id: document.id } });
  return { document, data };
}
