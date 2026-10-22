-- Stage 5.9: CA document requests.
--
-- A CA asks a client for a supporting document with a short explanation and a
-- required/optional flag. Uploaded files are `documents` rows of kind
-- 'supporting' linked by `request_id` (existing schema).

ALTER TABLE document_requests ADD COLUMN description TEXT
    CHECK (description IS NULL OR length(description) <= 500);

ALTER TABLE document_requests ADD COLUMN required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1));
