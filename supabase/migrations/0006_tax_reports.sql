-- ITR Intake schema version 6: AIS / TIS / Form 26AS reports for reconciliation.
--
-- How to apply: after 0005, Supabase dashboard -> SQL Editor -> New query ->
-- paste this whole file -> Run. It refuses to run before version 5 or a
-- second time, without changing anything.
--
-- A CA uploads a tax report (CSV or Excel export) for a case. The original
-- file is kept in private storage as a `documents` row of kind 'tax_report';
-- the records read from it are stored with their source row and cells so each
-- can be traced back. Matching against the bank statement is computed when the
-- case is viewed (it follows the current review and the CA's category
-- decisions); only the CA's verdict on a record is stored, together with the
-- match the CA saw, so a verdict never silently carries over to a changed match.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 5) THEN
        RAISE EXCEPTION 'ITR Intake schema version 5 is missing; apply 0005 first.';
    END IF;
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = 6) THEN
        RAISE EXCEPTION 'ITR Intake schema version 6 is already applied; nothing to do.';
    END IF;
END $$;

ALTER TABLE documents DROP CONSTRAINT documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check
    CHECK (kind IN ('bank_statement', 'supporting', 'workbook', 'tax_report'));

CREATE TABLE tax_reports (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id        uuid NOT NULL,
    firm_id        uuid NOT NULL,
    document_id    uuid NOT NULL UNIQUE,
    kind           text NOT NULL CHECK (kind IN ('ais', 'tis', 'form26as')),
    file_type      text NOT NULL CHECK (file_type IN ('csv', 'xlsx')),
    display_name   text NOT NULL CHECK (length(trim(display_name)) > 0),
    records_count  integer NOT NULL CHECK (records_count > 0),
    -- Rows that could not be read: row numbers and fixed codes only.
    warnings_json  jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings_json) = 'array'),
    uploaded_by    uuid NOT NULL,
    withdrawn_at   timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, case_id, firm_id),
    FOREIGN KEY (case_id, firm_id) REFERENCES cases (id, firm_id) ON DELETE CASCADE,
    FOREIGN KEY (document_id, case_id, firm_id) REFERENCES documents (id, case_id, firm_id),
    FOREIGN KEY (uploaded_by, firm_id) REFERENCES ca_users (id, firm_id)
);

CREATE TABLE tax_report_records (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id           uuid NOT NULL,
    case_id             uuid NOT NULL,
    firm_id             uuid NOT NULL,
    source_row          integer NOT NULL CHECK (source_row > 0),
    category            text NOT NULL CHECK (category IN ('salary', 'interest_savings', 'interest_deposit',
                            'interest_other', 'dividend', 'securities_sale', 'rent', 'tax_refund', 'cash_deposit', 'other')),
    description         text NOT NULL CHECK (length(trim(description)) > 0 AND length(description) <= 300),
    party               text CHECK (party IS NULL OR length(party) <= 200),
    txn_date            date,
    amount              numeric(18, 2) NOT NULL CHECK (amount >= 0),
    tax_deducted        numeric(18, 2) CHECK (tax_deducted IS NULL OR tax_deducted >= 0),
    -- The source row's cells exactly as read.
    raw_json            jsonb NOT NULL CHECK (jsonb_typeof(raw_json) = 'array'),
    review_status       text CHECK (review_status IS NULL OR review_status IN ('confirmed', 'unresolved')),
    review_note         text CHECK (review_note IS NULL OR (length(trim(review_note)) > 0 AND length(review_note) <= 300)),
    -- The match (status and bank rows) the CA saw when giving the verdict.
    reviewed_match      text,
    reviewed_by         uuid,
    reviewed_at         timestamptz,
    CHECK ((review_status IS NULL) = (reviewed_at IS NULL)),
    CHECK ((review_status IS NULL) = (reviewed_by IS NULL)),
    UNIQUE (report_id, source_row),
    FOREIGN KEY (report_id, case_id, firm_id) REFERENCES tax_reports (id, case_id, firm_id) ON DELETE CASCADE,
    FOREIGN KEY (case_id, firm_id) REFERENCES cases (id, firm_id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by, firm_id) REFERENCES ca_users (id, firm_id)
);

-- Same lock-down as every other table (see schema.sql).
ALTER TABLE tax_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_report_records ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON tax_reports, tax_report_records FROM anon, authenticated';
    END IF;
END $$;

INSERT INTO schema_migrations (version, name) VALUES (6, 'tax_reports');

COMMIT;
