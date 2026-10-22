-- Stage 5.4: e-mail worker support.
--
-- email_outbox gains two columns so secret-bearing messages (verification and
-- password-reset links) can be kept only as long as they are useful:
--   sensitive        1 when the body holds a one-time link or code.
--   body_expires_at  when a sensitive body must be gone, delivered or not
--                    (the worker clears it and marks an undelivered message dead).
--
-- dev_mailbox is the development-only simulated inbox. Only the simulated
-- sender writes to it, and only in the development environment; it stays empty
-- in production. Rows are deleted when they expire (the link's own lifetime).

ALTER TABLE email_outbox ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1));

ALTER TABLE email_outbox ADD COLUMN body_expires_at TEXT
    CHECK (body_expires_at IS NULL OR body_expires_at LIKE '____-__-__T__:__:__%Z');

CREATE TABLE dev_mailbox (
    id         TEXT PRIMARY KEY CHECK (length(id) = 36),
    outbox_id  TEXT NOT NULL UNIQUE REFERENCES email_outbox (id),
    recipient  TEXT NOT NULL CHECK (recipient LIKE '%_@_%'),
    subject    TEXT NOT NULL CHECK (length(subject) > 0),
    body_text  TEXT NOT NULL,
    link       TEXT,
    created_at TEXT NOT NULL CHECK (created_at LIKE '____-__-__T__:__:__%Z'),
    expires_at TEXT NOT NULL CHECK (expires_at LIKE '____-__-__T__:__:__%Z')
) STRICT;

CREATE INDEX dev_mailbox_expiry_idx ON dev_mailbox (expires_at);
