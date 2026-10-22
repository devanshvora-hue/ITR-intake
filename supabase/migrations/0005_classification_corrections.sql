-- ITR Intake schema version 5: the CA's classification decisions.
--
-- How to apply: after 0004, Supabase dashboard -> SQL Editor -> New query ->
-- paste this whole file -> Run. It refuses to run before version 4 or a
-- second time, without changing anything.
--
-- statement_rows keeps exactly what was extracted and what the classifier
-- said; it is rebuilt whenever a review is prepared. A CA's decision on a row
-- lives here instead, keyed by the reviewed upload and row number, with a
-- fingerprint of the row's raw extracted text. Re-preparing the same upload
-- keeps every decision whose row still reads the same; a decision whose row no
-- longer matches is kept but not applied. Every change is also an audit event.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 4) THEN
        RAISE EXCEPTION 'ITR Intake schema version 4 is missing; apply 0004 first.';
    END IF;
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = 5) THEN
        RAISE EXCEPTION 'ITR Intake schema version 5 is already applied; nothing to do.';
    END IF;
END $$;

CREATE TABLE classification_corrections (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id           uuid NOT NULL,
    firm_id           uuid NOT NULL,
    upload_id         uuid NOT NULL,
    row_number        integer NOT NULL CHECK (row_number > 0),
    -- SHA-256 of the row's raw extracted date, narration, debit, credit and balance.
    row_fingerprint   text NOT NULL CHECK (row_fingerprint ~ '^[0-9a-f]{64}$'),
    -- What the classifier said when the CA decided (for the audit trail).
    original_category text NOT NULL,
    category          text NOT NULL CHECK (category IN (
                          'Salary / Pension', 'Business / Professional Receipts', 'Rent Received',
                          'Interest – Savings Bank', 'Interest – FD / RD / Others', 'Dividend',
                          'Sale / Redemption of Investments', 'Income Tax Refund',
                          'Loans Received / Repayment of Loans Given', 'Gifts / Receipts from Non-relatives',
                          'Investments – Tax-saving', 'Investments – Others', 'Insurance – Health',
                          'Loan EMI / Repayment', 'Loans Given', 'Tax Payments', 'Donations',
                          'Credit Card Payments', 'Rent Paid', 'Business / Professional Expenses',
                          'Self Transfer', 'Family Transfer', 'Cash Withdrawal', 'Cash Deposit',
                          'Personal Expenses', 'Bank Charges', 'Reversals / Refunds', 'Others – Needs Review')),
    -- 'confirmed': the CA kept the classifier's category; 'changed': the CA chose another one.
    decision          text NOT NULL CHECK (decision IN ('confirmed', 'changed')),
    note              text CHECK (note IS NULL OR (length(trim(note)) > 0 AND length(note) <= 300)),
    decided_by        uuid NOT NULL,
    decided_at        timestamptz NOT NULL DEFAULT now(),
    CHECK ((decision = 'confirmed') = (category = original_category)),
    UNIQUE (case_id, upload_id, row_number),
    FOREIGN KEY (case_id, firm_id) REFERENCES cases (id, firm_id) ON DELETE CASCADE,
    FOREIGN KEY (upload_id, case_id, firm_id) REFERENCES statement_uploads (id, case_id, firm_id) ON DELETE CASCADE,
    FOREIGN KEY (decided_by, firm_id) REFERENCES ca_users (id, firm_id)
);

-- Same lock-down as every other table (see schema.sql).
ALTER TABLE classification_corrections ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON classification_corrections FROM anon, authenticated';
    END IF;
END $$;

INSERT INTO schema_migrations (version, name) VALUES (5, 'classification_corrections');

COMMIT;
