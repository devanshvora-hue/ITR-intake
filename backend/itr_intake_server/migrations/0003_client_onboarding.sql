-- Stage 5.6: client onboarding.
--
-- A client starts with a firm code and an e-mail address, verifies the
-- address, and then opens a case. The case must record the firm code that was
-- used (cases.created_via_firm_code_id), so the code is carried through:
--   verification_challenges.firm_code_id  the code the client entered
--   sessions.firm_code_id                  the code behind a client session
-- Both are nullable (CA challenges and CA sessions have none). SQLite cannot
-- add a composite foreign key to an existing table, so triggers enforce that
-- the code belongs to the same firm and is only used by client rows.

ALTER TABLE verification_challenges ADD COLUMN firm_code_id TEXT REFERENCES firm_codes (id);

ALTER TABLE sessions ADD COLUMN firm_code_id TEXT REFERENCES firm_codes (id);

CREATE TRIGGER verification_challenges_firm_code_insert
BEFORE INSERT ON verification_challenges
WHEN NEW.firm_code_id IS NOT NULL AND (NEW.purpose <> 'client_login' OR NOT EXISTS (
    SELECT 1 FROM firm_codes WHERE id = NEW.firm_code_id AND firm_id = NEW.firm_id))
BEGIN
    SELECT RAISE(ABORT, 'firm code must belong to the challenge firm');
END;

CREATE TRIGGER verification_challenges_firm_code_update
BEFORE UPDATE OF firm_code_id, firm_id, purpose ON verification_challenges
WHEN NEW.firm_code_id IS NOT NULL AND (NEW.purpose <> 'client_login' OR NOT EXISTS (
    SELECT 1 FROM firm_codes WHERE id = NEW.firm_code_id AND firm_id = NEW.firm_id))
BEGIN
    SELECT RAISE(ABORT, 'firm code must belong to the challenge firm');
END;

CREATE TRIGGER sessions_firm_code_insert
BEFORE INSERT ON sessions
WHEN NEW.firm_code_id IS NOT NULL AND (NEW.kind <> 'client' OR NOT EXISTS (
    SELECT 1 FROM firm_codes WHERE id = NEW.firm_code_id AND firm_id = NEW.firm_id))
BEGIN
    SELECT RAISE(ABORT, 'firm code must belong to the session firm');
END;

CREATE TRIGGER sessions_firm_code_update
BEFORE UPDATE OF firm_code_id, firm_id, kind ON sessions
WHEN NEW.firm_code_id IS NOT NULL AND (NEW.kind <> 'client' OR NOT EXISTS (
    SELECT 1 FROM firm_codes WHERE id = NEW.firm_code_id AND firm_id = NEW.firm_id))
BEGIN
    SELECT RAISE(ABORT, 'firm code must belong to the session firm');
END;

CREATE INDEX verification_challenges_client_idx
    ON verification_challenges (purpose, firm_id, subject) WHERE purpose = 'client_login';
