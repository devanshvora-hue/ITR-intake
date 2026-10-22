"""Stage 5.1: SQLite foundation. Every test uses a temporary database
(pytest's tmp_path or :memory:); no real database or client data is involved.
All rows are synthetic."""

import shutil
import sqlite3

import pytest

from itr_intake_server.db import (
    DEFAULT_DATABASE_PATH,
    MIGRATIONS_DIR,
    VAR_DIR,
    MigrationError,
    apply_migrations,
    connect,
    discover_migrations,
    initialize_database,
    new_id,
    transaction,
    utc_now,
)

TABLES = {
    "firms", "ca_users", "firm_codes", "client_identities", "verification_challenges", "sessions",
    "rate_limits", "cases", "statement_rows", "questions", "confirmations", "document_requests",
    "documents", "email_outbox", "audit_events", "dev_mailbox", "statement_uploads",
}
HASH = "a" * 64


@pytest.fixture
def db(tmp_path):
    conn = initialize_database(tmp_path / "test.db")
    yield conn
    conn.close()


# --- synthetic row helpers ---------------------------------------------------------------

def add_firm(db, name="Demo & Co (synthetic)", status="active"):
    fid, now = new_id(), utc_now()
    db.execute(
        "INSERT INTO firms (id, name, status, approved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (fid, name, status, now if status == "active" else None, now, now),
    )
    return fid


def add_ca_user(db, firm_id, email=None):
    uid, now = new_id(), utc_now()
    db.execute(
        "INSERT INTO ca_users (id, firm_id, email_norm, full_name, password_hash, created_at, updated_at) "
        "VALUES (?, ?, ?, 'Demo CA', 'scrypt$synthetic', ?, ?)",
        (uid, firm_id, email or f"ca-{uid[:8]}@example.test", now, now),
    )
    return uid


def add_client(db, firm_id, email="client@example.test"):
    cid = new_id()
    db.execute("INSERT INTO client_identities (id, firm_id, email_norm, created_at) VALUES (?, ?, ?, ?)",
               (cid, firm_id, email, utc_now()))
    return cid


def add_firm_code(db, firm_id, code=None, status="active"):
    kid, now = new_id(), utc_now()
    db.execute("INSERT INTO firm_codes (id, firm_id, code, status, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)",
               (kid, firm_id, code or kid.replace("-", "")[:10].upper(), status, now,
                now if status == "revoked" else None))
    return kid


def add_case(db, firm_id, client_id, fy="2025-26", status="draft", code_id=None, ref=None):
    cid, now = new_id(), utc_now()
    db.execute(
        "INSERT INTO cases (id, firm_id, client_identity_id, reference, financial_year, client_first_name, status, "
        "created_via_firm_code_id, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, 'Demo', ?, ?, ?, ?, ?)",
        (cid, firm_id, client_id, ref or f"IT-DEMO-{cid[:6].upper()}", fy, status, code_id, now, now,
         now if status == "closed" else None),
    )
    return cid


@pytest.fixture
def world(db):
    """Two synthetic firms, each with a CA user, client, firm code and case."""
    out = {}
    for tag in ("a", "b"):
        firm = add_firm(db, f"Firm {tag.upper()} (synthetic)")
        out[tag] = {
            "firm": firm,
            "user": add_ca_user(db, firm, f"ca-{tag}@example.test"),
            "client": add_client(db, firm, f"client-{tag}@example.test"),
            "code": add_firm_code(db, firm, f"FIRMCODE{tag.upper()}1"),
        }
        out[tag]["case"] = add_case(db, firm, out[tag]["client"], code_id=out[tag]["code"])
    return out


def statement_row(db, case_id, firm_id, n=1, **over):
    vals = dict(case_id=case_id, firm_id=firm_id, row_number=n, raw_date="01/04/2025", raw_narration="SYNTHETIC",
                raw_debit="", raw_credit="100.00", raw_balance="100.00", is_valid=1, txn_date="2025-04-01",
                narration="SYNTHETIC", debit="0", credit="100.00", balance="100.00",
                category="Others – Needs Review", review_status="Needs review")
    vals.update(over)
    cols = ", ".join(vals)
    db.execute(f"INSERT INTO statement_rows ({cols}) VALUES ({', '.join('?' * len(vals))})", tuple(vals.values()))


# === initialisation ===========================================================================

def test_fresh_database_has_full_schema(tmp_path):
    conn = initialize_database(tmp_path / "fresh.db")
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert tables == TABLES | {"schema_migrations"}
    rows = conn.execute("SELECT version, name FROM schema_migrations").fetchall()
    assert [tuple(r) for r in rows] == [(1, "initial_schema"), (2, "email_worker"), (3, "client_onboarding"), (4, "statement_uploads"), (5, "case_review"), (6, "document_requests")]
    strict = {r["name"]: r["strict"] for r in conn.execute("SELECT name, strict FROM pragma_table_list WHERE schema = 'main'")}
    assert {t for t in TABLES if strict.get(t) == 1} == TABLES  # every table is STRICT
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    conn.close()


def test_every_connection_enforces_foreign_keys(tmp_path):
    path = tmp_path / "fk.db"
    initialize_database(path).close()
    with connect(path) as conn:
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    # A plain sqlite3 connection does not, which is why connect() must be used.
    raw = sqlite3.connect(path)
    assert raw.execute("PRAGMA foreign_keys").fetchone()[0] == 0
    raw.close()


def test_migrations_refuse_a_connection_without_foreign_keys(tmp_path):
    raw = sqlite3.connect(tmp_path / "raw.db", isolation_level=None)
    with pytest.raises(MigrationError, match="Foreign-key enforcement"):
        apply_migrations(raw)
    raw.close()


def test_repeated_initialisation_is_idempotent(tmp_path):
    path = tmp_path / "repeat.db"

    def snapshot(conn):
        return sorted(tuple(r) for r in conn.execute("SELECT type, name, tbl_name, sql FROM sqlite_master"))

    conn = initialize_database(path)
    first = snapshot(conn)
    add_firm(conn)  # existing data must survive re-initialisation
    conn.close()
    for _ in range(3):
        conn = initialize_database(path)
        assert snapshot(conn) == first
        assert apply_migrations(conn) == []
        assert conn.execute("SELECT count(*) FROM schema_migrations").fetchone()[0] == 6
        assert conn.execute("SELECT count(*) FROM firms").fetchone()[0] == 1
        conn.close()


def test_modified_applied_migration_is_refused(tmp_path):
    mdir = tmp_path / "migrations"
    shutil.copytree(MIGRATIONS_DIR, mdir)
    conn = initialize_database(tmp_path / "m.db", mdir)
    (mdir / "0001_initial_schema.sql").write_text(
        (mdir / "0001_initial_schema.sql").read_text(encoding="utf-8") + "\n-- edited\n", encoding="utf-8")
    with pytest.raises(MigrationError, match="has been modified"):
        apply_migrations(conn, mdir)
    conn.close()


def test_unknown_applied_version_is_refused(tmp_path, db):
    db.execute("INSERT INTO schema_migrations VALUES (99, 'future', ?, ?)", (HASH, utc_now()))
    with pytest.raises(MigrationError, match="does not know"):
        apply_migrations(db)


@pytest.mark.parametrize(
    "files, match",
    [
        ({"0001_a.sql": "SELECT 1;", "0003_c.sql": "SELECT 1;"}, "without gaps"),
        ({"0001_a.sql": "SELECT 1;", "0001_b.sql": "SELECT 1;"}, "Duplicate"),
        ({"1_bad.sql": "SELECT 1;"}, "not recognised"),
    ],
)
def test_ambiguous_migration_sets_are_refused(tmp_path, files, match):
    mdir = tmp_path / "migrations"
    mdir.mkdir()
    for name, sql in files.items():
        (mdir / name).write_text(sql, encoding="utf-8")
    with pytest.raises(MigrationError, match=match):
        discover_migrations(mdir)


def test_migration_managing_its_own_transaction_is_refused(tmp_path):
    mdir = tmp_path / "migrations"
    mdir.mkdir()
    (mdir / "0001_bad.sql").write_text("BEGIN;\nCREATE TABLE t (a TEXT) STRICT;\nCOMMIT;\n", encoding="utf-8")
    conn = connect(tmp_path / "t.db")
    with pytest.raises(MigrationError, match="own transaction"):
        apply_migrations(conn, mdir)
    conn.close()


# === failing migrations roll back ===================================================================

def test_failing_migration_rolls_back_completely(tmp_path):
    mdir = tmp_path / "migrations"
    shutil.copytree(MIGRATIONS_DIR, mdir)
    (mdir / "0007_broken.sql").write_text(
        "CREATE TABLE half_done (id TEXT PRIMARY KEY) STRICT;\n"
        "ALTER TABLE firms ADD COLUMN extra TEXT;\n"
        "INSERT INTO no_such_table VALUES (1);\n",  # fails after two successful statements
        encoding="utf-8",
    )
    path = tmp_path / "rollback.db"
    with pytest.raises(MigrationError, match="0007_broken.sql failed and was rolled back"):
        initialize_database(path, mdir)

    conn = connect(path)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "half_done" not in tables and TABLES <= tables
    assert "extra" not in {r["name"] for r in conn.execute("PRAGMA table_info(firms)")}
    assert [r[0] for r in conn.execute("SELECT version FROM schema_migrations")] == [1, 2, 3, 4, 5, 6]
    assert not conn.in_transaction
    add_firm(conn)  # the database is still usable

    # Once fixed, the migration applies cleanly.
    (mdir / "0007_broken.sql").write_text("CREATE TABLE half_done (id TEXT PRIMARY KEY) STRICT;\n", encoding="utf-8")
    assert apply_migrations(conn, mdir) == [7]
    conn.close()


def test_transaction_helper_rolls_back_on_error(db):
    with pytest.raises(sqlite3.IntegrityError):
        with transaction(db):
            add_firm(db, "Kept? (synthetic)")
            db.execute("INSERT INTO firms (id) VALUES ('bad')")
    assert db.execute("SELECT count(*) FROM firms").fetchone()[0] == 0
    assert not db.in_transaction


# === foreign keys ==================================================================================

@pytest.mark.parametrize(
    "sql, params",
    [
        ("INSERT INTO ca_users (id, firm_id, email_norm, full_name, password_hash, created_at, updated_at) "
         "VALUES (?, ?, 'x@example.test', 'X', 'h', ?, ?)", lambda: (new_id(), new_id(), utc_now(), utc_now())),
        ("INSERT INTO client_identities (id, firm_id, email_norm, created_at) VALUES (?, ?, 'x@example.test', ?)",
         lambda: (new_id(), new_id(), utc_now())),
        ("INSERT INTO firm_codes (id, firm_id, code, created_at) VALUES (?, ?, 'ABCDEFGH12', ?)",
         lambda: (new_id(), new_id(), utc_now())),
    ],
)
def test_foreign_keys_reject_missing_parents(db, sql, params):
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        db.execute(sql, params())


def test_firm_with_dependents_cannot_be_deleted(db, world):
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        db.execute("DELETE FROM firms WHERE id = ?", (world["a"]["firm"],))


def test_deleting_a_case_removes_its_rows(db, world):
    a = world["a"]
    statement_row(db, a["case"], a["firm"])
    db.execute("DELETE FROM cases WHERE id = ?", (a["case"],))
    assert db.execute("SELECT count(*) FROM statement_rows").fetchone()[0] == 0


# === cross-firm and cross-case references =============================================================

def test_case_cannot_use_another_firms_client(db, world):
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        add_case(db, world["a"]["firm"], world["b"]["client"])


def test_case_cannot_record_another_firms_code(db, world):
    other_client = add_client(db, world["a"]["firm"], "second@example.test")
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        add_case(db, world["a"]["firm"], other_client, code_id=world["b"]["code"])


@pytest.mark.parametrize("table", ["statement_rows", "questions", "confirmations", "document_requests",
                                   "documents", "email_outbox", "audit_events"])
def test_case_scoped_rows_must_match_the_cases_firm(db, world, table):
    case_a, firm_b = world["a"]["case"], world["b"]["firm"]
    now = utc_now()
    inserts = {
        "statement_rows": lambda: statement_row(db, case_a, firm_b),
        "questions": lambda: db.execute(
            "INSERT INTO questions (case_id, firm_id, question_id, seq, question, purpose, finding_ids_json, "
            "transaction_ids_json, created_at) VALUES (?, ?, 'Q-1', 1, 'What?', 'p', '[\"F0001\"]', '[\"T0001\"]', ?)",
            (case_a, firm_b, now)),
        "confirmations": lambda: db.execute(
            "INSERT INTO confirmations (case_id, firm_id, seq, finding_id, proposed_category, response, created_at) "
            "VALUES (?, ?, 1, 'F0001', 'Family Transfer', 'confirmed', ?)", (case_a, firm_b, now)),
        "document_requests": lambda: db.execute(
            "INSERT INTO document_requests (id, case_id, firm_id, key, label, source, created_at, updated_at) "
            "VALUES (?, ?, ?, 'form_16', 'Form 16', 'rules', ?, ?)", (new_id(), case_a, firm_b, now, now)),
        "documents": lambda: db.execute(
            "INSERT INTO documents (id, case_id, firm_id, kind, storage_key, display_name, content_type, size_bytes, "
            "sha256, uploaded_by, created_at) VALUES (?, ?, ?, 'bank_statement', ?, 's.pdf', 'application/pdf', 10, ?, "
            "'client', ?)", (new_id(), case_a, firm_b, f"{firm_b}/{case_a}/{new_id()}.pdf", HASH, now)),
        "email_outbox": lambda: db.execute(
            "INSERT INTO email_outbox (id, idempotency_key, firm_id, case_id, template, recipient, subject, "
            "created_at, updated_at) VALUES (?, 'k1', ?, ?, 't', 'x@example.test', 's', ?, ?)",
            (new_id(), firm_b, case_a, now, now)),
        "audit_events": lambda: db.execute(
            "INSERT INTO audit_events (id, firm_id, case_id, actor_kind, action, created_at) "
            "VALUES (?, ?, ?, 'system', 'test', ?)", (new_id(), firm_b, case_a, now)),
    }
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        inserts[table]()


def test_session_firm_must_match_the_users_firm(db, world):
    now = utc_now()
    base = "INSERT INTO sessions (id, token_hash, kind, firm_id, ca_user_id, client_identity_id, created_at, " \
           "last_seen_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        db.execute(base, (new_id(), "b" * 64, "ca", world["b"]["firm"], world["a"]["user"], None, now, now, now, now))
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        db.execute(base, (new_id(), "c" * 64, "client", world["b"]["firm"], None, world["a"]["client"], now, now, now, now))
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):  # a session has exactly one kind of user
        db.execute(base, (new_id(), "d" * 64, "ca", world["a"]["firm"], world["a"]["user"], world["a"]["client"],
                          now, now, now, now))
    db.execute(base, (new_id(), "e" * 64, "ca", world["a"]["firm"], world["a"]["user"], None, now, now, now, now))


def test_document_cannot_fulfil_another_cases_request(db, world):
    a = world["a"]
    second = add_case(db, a["firm"], add_client(db, a["firm"], "other@example.test"))
    now, req = utc_now(), new_id()
    db.execute("INSERT INTO document_requests (id, case_id, firm_id, key, label, source, created_at, updated_at) "
               "VALUES (?, ?, ?, 'form_16', 'Form 16', 'rules', ?, ?)", (req, second, a["firm"], now, now))
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        db.execute("INSERT INTO documents (id, case_id, firm_id, request_id, kind, storage_key, display_name, "
                   "content_type, size_bytes, sha256, uploaded_by, created_at) VALUES (?, ?, ?, ?, 'supporting', ?, "
                   "'f.pdf', 'application/pdf', 10, ?, 'client', ?)",
                   (new_id(), a["case"], a["firm"], req, f"{a['firm']}/{a['case']}/{new_id()}.pdf", HASH, now))


@pytest.mark.parametrize(
    "key",
    [
        lambda f, c: f"{f}/{new_id()}/doc.pdf",  # another case's directory
        lambda f, c: f"{new_id()}/{c}/doc.pdf",  # another firm's directory
        lambda f, c: f"{f}/{c}/../../etc/passwd",
        lambda f, c: f"{f}/{c}/sub/doc.pdf",
        lambda f, c: f"/{f}/{c}/doc.pdf",
        lambda f, c: f"{f}/{c}/",
        lambda f, c: f"{f}/{c}/C:doc.pdf",
        lambda f, c: f"{f}/{c}/a\\b.pdf",
    ],
)
def test_document_storage_key_is_confined_to_its_case(db, world, key):
    a = world["a"]
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        db.execute("INSERT INTO documents (id, case_id, firm_id, kind, storage_key, display_name, content_type, "
                   "size_bytes, sha256, uploaded_by, created_at) VALUES (?, ?, ?, 'bank_statement', ?, 's.pdf', "
                   "'application/pdf', 10, ?, 'client', ?)",
                   (new_id(), a["case"], a["firm"], key(a["firm"], a["case"]), HASH, utc_now()))


# === one open case per client identity, firm and financial year ===========================================

def test_second_open_case_for_same_client_and_year_is_rejected(db, world):
    a = world["a"]
    with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
        add_case(db, a["firm"], a["client"])
    for status in ("submitted", "review_ready", "ca_review_required"):  # still "open"
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
            add_case(db, a["firm"], a["client"], status=status)


@pytest.mark.parametrize(
    "status",
    ["draft", "statement_uploaded", "processing", "questions_in_progress", "documents_pending",
     "submitted", "ca_review_required", "review_ready"],
)
def test_only_closing_a_case_releases_the_open_case_slot(db, world, status):
    # Confirmed decision: submitted and review_ready cases (and every other
    # non-closed status) still occupy the slot; only `closed` frees it.
    a = world["a"]
    db.execute("UPDATE cases SET status = ? WHERE id = ?", (status, a["case"]))
    with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
        add_case(db, a["firm"], a["client"])
    db.execute("UPDATE cases SET status = 'closed', closed_at = ? WHERE id = ?", (utc_now(), a["case"]))
    add_case(db, a["firm"], a["client"])


def test_registration_numbers_are_unique_for_the_prototype(db):
    # Confirmed decision; see the README caveat about firm branches.
    now = utc_now()
    sql = "INSERT INTO firms (id, name, registration_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    db.execute(sql, (new_id(), "Demo Firm (synthetic)", "FRN-000001-SYN", now, now))
    with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
        db.execute(sql, (new_id(), "Demo Firm Branch (synthetic)", "FRN-000001-SYN", now, now))
    # Firms without a registration number are not affected.
    db.execute(sql, (new_id(), "Unregistered A (synthetic)", None, now, now))
    db.execute(sql, (new_id(), "Unregistered B (synthetic)", None, now, now))


def test_other_years_and_other_clients_are_allowed(db, world):
    a = world["a"]
    add_case(db, a["firm"], a["client"], fy="2024-25")
    add_case(db, a["firm"], add_client(db, a["firm"], "another@example.test"))


def test_new_case_allowed_after_closing_and_reopening_blocked(db, world):
    a = world["a"]
    db.execute("UPDATE cases SET status = 'closed', closed_at = ? WHERE id = ?", (utc_now(), a["case"]))
    newer = add_case(db, a["firm"], a["client"])
    add_case(db, a["firm"], a["client"], status="closed")  # several closed cases are fine
    assert newer
    with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
        db.execute("UPDATE cases SET status = 'draft', closed_at = NULL WHERE id = ?", (a["case"],))


def test_closed_status_and_closed_at_go_together(db, world):
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        db.execute("UPDATE cases SET status = 'closed' WHERE id = ?", (world["a"]["case"],))
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        db.execute("UPDATE cases SET closed_at = ? WHERE id = ?", (utc_now(), world["a"]["case"]))


# === other constraints ===================================================================================

def test_one_active_firm_code_per_firm(db, world):
    a = world["a"]
    with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
        add_firm_code(db, a["firm"], "ANOTHERCODE")
    add_firm_code(db, a["firm"], "OLDCODE123", status="revoked")
    with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):  # codes are globally unique
        add_firm_code(db, world["b"]["firm"], "FIRMCODEA1", status="revoked")


def test_one_pending_question_per_case(db, world):
    a, now = world["a"], utc_now()
    sql = ("INSERT INTO questions (case_id, firm_id, question_id, seq, question, purpose, finding_ids_json, "
           "transaction_ids_json, created_at) VALUES (?, ?, ?, ?, 'What was it for?', 'p', '[\"F0001\"]', '[\"T0001\"]', ?)")
    db.execute(sql, (a["case"], a["firm"], "Q-1", 1, now))
    with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
        db.execute(sql, (a["case"], a["firm"], "Q-2", 2, now))
    db.execute("UPDATE questions SET status = 'answered', answer_text = 'A loan.', answered_at = ? WHERE question_id = 'Q-1'",
               (now,))
    db.execute(sql, (a["case"], a["firm"], "Q-2", 2, now))


@pytest.mark.parametrize(
    "column, value, ok",
    [
        ("credit", "12.50", True), ("credit", "1250", True), ("credit", "1e5", False), ("credit", "abc", False),
        ("credit", "-5.00", False), ("credit", "1.2.3", False), ("credit", "", False),
        ("balance", "-5.00", True), ("balance", "5-0", False), ("balance", "--5", False),
    ],
)
def test_money_is_decimal_text(db, world, column, value, ok):
    a = world["a"]
    if ok:
        statement_row(db, a["case"], a["firm"], **{column: value})
        stored = db.execute(f"SELECT {column}, typeof({column}) FROM statement_rows").fetchone()
        assert tuple(stored) == (value, "text")
    else:
        with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
            statement_row(db, a["case"], a["firm"], **{column: value})


def test_category_must_be_canonical(db, world):
    a = world["a"]
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        statement_row(db, a["case"], a["firm"], category="Misc")
    from itr_intake import CANONICAL_CATEGORIES
    for n, category in enumerate(CANONICAL_CATEGORIES, start=1):
        statement_row(db, a["case"], a["firm"], n=n, category=category)


def test_timestamps_must_be_utc_iso(db):
    fid = new_id()
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        db.execute("INSERT INTO firms (id, name, created_at, updated_at) VALUES (?, 'X', '2025-04-01 10:00:00', ?)",
                   (fid, utc_now()))
    stamp = utc_now()
    assert stamp.endswith("Z") and stamp[10] == "T"


def test_append_only_tables(db, world):
    a, now = world["a"], utc_now()
    db.execute("INSERT INTO confirmations (case_id, firm_id, seq, finding_id, proposed_category, response, created_at) "
               "VALUES (?, ?, 1, 'F0008', 'Family Transfer', 'confirmed', ?)", (a["case"], a["firm"], now))
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        db.execute("UPDATE confirmations SET response = 'denied'")
    db.execute("INSERT INTO audit_events (id, firm_id, actor_kind, action, created_at) VALUES (?, ?, 'system', 'x', ?)",
               (new_id(), a["firm"], now))
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        db.execute("UPDATE audit_events SET action = 'y'")
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        db.execute("DELETE FROM audit_events")


def test_ids_and_hashes_are_well_formed(db):
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        db.execute("INSERT INTO firms (id, name, created_at, updated_at) VALUES ('firm-1', 'X', ?, ?)",
                   (utc_now(), utc_now()))
    assert len(new_id()) == 36 and new_id() != new_id()


def test_email_must_be_normalised(db):
    firm = add_firm(db)
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        add_client(db, firm, "Client@Example.test")


# === storage location =========================================================================================

def test_default_database_lives_under_backend_var():
    assert DEFAULT_DATABASE_PATH.parent == VAR_DIR and VAR_DIR.name == "var" and VAR_DIR.parent.name == "backend"


def test_database_inside_a_private_folder_is_refused(tmp_path):
    with pytest.raises(ValueError, match="Private"):
        connect(tmp_path / "Private" / "x.db")
