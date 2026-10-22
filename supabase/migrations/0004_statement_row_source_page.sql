-- ITR Intake schema version 4: the source page of each extracted statement row.
--
-- How to apply: after 0003, Supabase dashboard -> SQL Editor -> New query ->
-- paste this whole file -> Run. It refuses to run before version 3 or a
-- second time, without changing anything.
--
-- With row_number (the row's position in the statement) and the raw_* columns
-- (the text exactly as read), the page lets a CA trace every extracted row
-- back to the original file, which stays in private storage. NULL for CSV.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 3) THEN
        RAISE EXCEPTION 'ITR Intake schema version 3 is missing; apply 0003 first.';
    END IF;
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = 4) THEN
        RAISE EXCEPTION 'ITR Intake schema version 4 is already applied; nothing to do.';
    END IF;
END $$;

ALTER TABLE statement_rows ADD COLUMN source_page integer CHECK (source_page IS NULL OR source_page > 0);

INSERT INTO schema_migrations (version, name) VALUES (4, 'statement_row_source_page');

COMMIT;
