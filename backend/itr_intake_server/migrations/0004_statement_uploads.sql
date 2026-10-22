-- Stage 5.7: bank-statement uploads and their processing results.
--
-- A stored statement file is a `documents` row (kind 'bank_statement',
-- private storage key, sha256). Each upload attempt, stored or not, gets a
-- `statement_uploads` row with its processing outcome. Files rejected at the
-- file-validation stage are never stored, so they have no document.
--
-- Only counts, codes, row numbers and page numbers are kept here: never
-- transaction text, amounts or account details.

CREATE TABLE statement_uploads (
    id                  TEXT PRIMARY KEY CHECK (length(id) = 36),
    case_id             TEXT NOT NULL,
    firm_id             TEXT NOT NULL,
    document_id         TEXT UNIQUE REFERENCES documents (id),
    file_type           TEXT NOT NULL CHECK (file_type IN ('pdf', 'csv', 'unknown')),
    display_name        TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
    size_bytes          INTEGER NOT NULL CHECK (size_bytes >= 0),
    status              TEXT NOT NULL CHECK (status IN ('processing', 'extracted', 'manual_review_required',
                                                        'rejected', 'processing_failed')),
    reasons_json        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons_json) AND json_type(reasons_json) = 'array'),
    page_warnings_json  TEXT NOT NULL DEFAULT '[]'
                        CHECK (json_valid(page_warnings_json) AND json_type(page_warnings_json) = 'array'),
    rejected_rows_json  TEXT NOT NULL DEFAULT '[]'
                        CHECK (json_valid(rejected_rows_json) AND json_type(rejected_rows_json) = 'array'),
    duplicate_rows_json TEXT NOT NULL DEFAULT '[]'
                        CHECK (json_valid(duplicate_rows_json) AND json_type(duplicate_rows_json) = 'array'),
    pages_total         INTEGER CHECK (pages_total IS NULL OR pages_total >= 0),
    rows_extracted      INTEGER NOT NULL DEFAULT 0 CHECK (rows_extracted >= 0),
    rows_rejected       INTEGER NOT NULL DEFAULT 0 CHECK (rows_rejected >= 0),
    rows_duplicate      INTEGER NOT NULL DEFAULT 0 CHECK (rows_duplicate >= 0),
    rows_summary        INTEGER NOT NULL DEFAULT 0 CHECK (rows_summary >= 0),
    period_start        TEXT CHECK (period_start IS NULL OR period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    period_end          TEXT CHECK (period_end IS NULL OR period_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    error_code          TEXT CHECK (error_code IS NULL OR (length(error_code) <= 64 AND error_code NOT GLOB '*[^a-z0-9_]*')),
    created_at          TEXT NOT NULL CHECK (created_at LIKE '____-__-__T__:__:__%Z'),
    processed_at        TEXT CHECK (processed_at IS NULL OR processed_at LIKE '____-__-__T__:__:__%Z'),
    -- Rejected files are never stored; everything else has its stored document.
    CHECK ((status = 'rejected') = (document_id IS NULL)),
    -- Only an upload still being processed has no completion time.
    CHECK ((status = 'processing') = (processed_at IS NULL)),
    FOREIGN KEY (case_id, firm_id) REFERENCES cases (id, firm_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX statement_uploads_case_idx ON statement_uploads (case_id, created_at);
CREATE INDEX statement_uploads_firm_idx ON statement_uploads (firm_id, created_at);

-- The document must be a bank statement of the same case and firm.
CREATE TRIGGER statement_uploads_document_scope_insert
BEFORE INSERT ON statement_uploads
WHEN NEW.document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM documents WHERE id = NEW.document_id AND case_id = NEW.case_id AND firm_id = NEW.firm_id
                              AND kind = 'bank_statement')
BEGIN
    SELECT RAISE(ABORT, 'statement document must belong to the same case');
END;

CREATE TRIGGER statement_uploads_document_scope_update
BEFORE UPDATE OF document_id, case_id, firm_id ON statement_uploads
WHEN NEW.document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM documents WHERE id = NEW.document_id AND case_id = NEW.case_id AND firm_id = NEW.firm_id
                              AND kind = 'bank_statement')
BEGIN
    SELECT RAISE(ABORT, 'statement document must belong to the same case');
END;
