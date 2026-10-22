-- Stage 5.8: CA case review.
--
-- A CA prepares a case for review from one of its stored bank-statement
-- uploads: the file is re-read locally, validated and classified, and the rows
-- replace the case's `statement_rows`. The case records which upload those
-- rows came from and when they were prepared. The classifier version, period
-- and balances already have columns on `cases`.

ALTER TABLE cases ADD COLUMN reviewed_upload_id TEXT REFERENCES statement_uploads (id);

ALTER TABLE cases ADD COLUMN reviewed_at TEXT
    CHECK (reviewed_at IS NULL OR reviewed_at LIKE '____-__-__T__:__:__%Z');

-- The reviewed upload must be a stored statement of the same case and firm.
CREATE TRIGGER cases_reviewed_upload_scope
BEFORE UPDATE OF reviewed_upload_id ON cases
WHEN NEW.reviewed_upload_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM statement_uploads
    WHERE id = NEW.reviewed_upload_id AND case_id = NEW.id AND firm_id = NEW.firm_id AND document_id IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'reviewed upload must be a stored statement of the same case');
END;
