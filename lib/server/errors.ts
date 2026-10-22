// Safe repository errors (ported from repository.py). Messages never contain
// row data; database constraint names map to stable codes.

import { DbError } from "./db";

export class NotFound extends Error {
  constructor() {
    super("Not found.");
    this.name = "NotFound";
  }
}

export class Conflict extends Error {
  constructor(readonly code: string) {
    super(`Conflict: ${code}.`);
    this.name = "Conflict";
  }
}

export class InvalidInput extends Error {
  constructor(readonly field: string) {
    super(`Invalid value: ${field}.`);
    this.name = "InvalidInput";
  }
}

const UNIQUE_CODES: Record<string, string> = {
  cases_one_open_per_client_year_uq: "open_case_exists",
  cases_reference_key: "reference_taken",
  firms_registration_number_uq: "registration_number_taken",
  ca_users_email_norm_key: "email_taken",
  firm_codes_one_active_uq: "active_firm_code_exists",
  firm_codes_code_key: "firm_code_taken",
  client_identities_firm_id_email_norm_key: "client_exists",
  document_requests_case_id_key_key: "document_request_exists",
  documents_case_id_kind_sha256_key: "duplicate_document",
  email_outbox_idempotency_key_key: "duplicate_email",
  sessions_token_hash_key: "duplicate_session",
};

/** Turn a DbError into NotFound / Conflict / InvalidInput; anything else passes through. */
export function translate(error: unknown, field = "value"): unknown {
  if (!(error instanceof DbError)) return error;
  if (error.isUniqueViolation) return new Conflict(UNIQUE_CODES[error.constraint ?? ""] ?? "duplicate");
  if (error.isForeignKeyViolation) return new NotFound();
  if (error.isCheckViolation || error.code === "22P02" || error.code === "23502") return new InvalidInput(field);
  return error;
}

/** Run a database call and translate constraint failures. */
export async function guarded<T>(fn: () => Promise<T>, field = "value"): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw translate(error, field);
  }
}

/** The single row of a result, or NotFound. */
export function one<T>(rows: T[]): T {
  if (rows.length === 0) throw new NotFound();
  return rows[0];
}
