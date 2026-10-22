-- ITR Intake schema version 2: the suggested document checklist.
--
-- How to apply: after schema.sql (version 1), Supabase dashboard -> SQL Editor
-- -> New query -> paste this whole file -> Run. It refuses to run before
-- version 1 or a second time, without changing anything.
--
-- A checklist item is a rules-generated suggestion for one case. It is never a
-- document request by itself: the CA converts an item into a request
-- (document_requests, source 'rules'), which links it here. The client may
-- answer an open suggestion with "unavailable" or "not applicable".

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 1) THEN
        RAISE EXCEPTION 'ITR Intake schema version 1 is missing; apply schema.sql first.';
    END IF;
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = 2) THEN
        RAISE EXCEPTION 'ITR Intake schema version 2 is already applied; nothing to do.';
    END IF;
END $$;

CREATE TABLE checklist_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id         uuid NOT NULL,
    firm_id         uuid NOT NULL,
    key             text NOT NULL CHECK (key ~ '^[a-z0-9_]+$'),
    label           text NOT NULL CHECK (length(trim(label)) > 0 AND length(label) <= 120),
    reason          text NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 500),
    level           text NOT NULL CHECK (level IN ('required', 'conditional', 'optional')),
    -- Why the rule fired: fixed codes and category names with row counts only.
    evidence_json   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_json) = 'array'),
    -- False once the case data no longer triggers the rule (kept for history and client answers).
    applies         boolean NOT NULL DEFAULT true,
    rules_version   text NOT NULL,
    client_response text CHECK (client_response IS NULL OR client_response IN ('unavailable', 'not_applicable')),
    client_note     text CHECK (client_note IS NULL OR (length(client_note) <= 300 AND client_response IS NOT NULL)),
    responded_at    timestamptz,
    ca_status       text NOT NULL DEFAULT 'suggested' CHECK (ca_status IN ('suggested', 'requested', 'dismissed')),
    request_id      uuid UNIQUE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK ((client_response IS NULL) = (responded_at IS NULL)),
    CHECK ((ca_status = 'requested') = (request_id IS NOT NULL)),
    UNIQUE (case_id, key),
    FOREIGN KEY (case_id, firm_id) REFERENCES cases (id, firm_id) ON DELETE CASCADE,
    -- A converted item points at a request of its own case.
    FOREIGN KEY (request_id, case_id) REFERENCES document_requests (id, case_id)
);

-- Same lock-down as every other table (see schema.sql).
ALTER TABLE checklist_items ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON checklist_items FROM anon, authenticated';
    END IF;
END $$;

INSERT INTO schema_migrations (version, name) VALUES (2, 'document_checklist');

COMMIT;
