-- ITR Intake schema version 3: direct client entry with resume codes.
--
-- How to apply: after 0002, Supabase dashboard -> SQL Editor -> New query ->
-- paste this whole file -> Run. It refuses to run before version 2 or a
-- second time, without changing anything.
--
-- Clients now start with firm code + e-mail and no e-mailed link, so the
-- e-mail is an identifier, not proof of identity (email_verified_at stays
-- NULL for them). To return from another browser a client also gives the
-- resume code shown when they first started. Only a SHA-256 hash is stored.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 2) THEN
        RAISE EXCEPTION 'ITR Intake schema version 2 is missing; apply 0002 first.';
    END IF;
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = 3) THEN
        RAISE EXCEPTION 'ITR Intake schema version 3 is already applied; nothing to do.';
    END IF;
END $$;

ALTER TABLE client_identities
    ADD COLUMN resume_code_hash   text CHECK (resume_code_hash IS NULL OR resume_code_hash ~ '^[0-9a-f]{64}$'),
    ADD COLUMN resume_code_set_at timestamptz,
    ADD CONSTRAINT client_identities_resume_code_pair CHECK ((resume_code_hash IS NULL) = (resume_code_set_at IS NULL));

INSERT INTO schema_migrations (version, name) VALUES (3, 'client_resume_codes');

COMMIT;
