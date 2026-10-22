"""CA case review (Stage 5.8, first backend task): case detail and review
preparation. Synthetic statements, temporary databases and storage only."""

import logging
import sqlite3

import pytest

import itr_intake_server.app as app_module
import itr_intake_server.ca_auth as auth
import itr_intake_server.case_review as case_review
import itr_intake_server.repository as repo
import itr_intake_server.statements as statements
from itr_intake_server.app import create_app
from itr_intake_server.db import connect
from itr_intake_server.settings import Settings
from test_client_onboarding import ca_with_code, open_case, sign_in
from test_server_app import DEV_ORIGIN, H, db_rows, new_client
from test_statement_uploads import CSV_OK, CSV_PARTLY_BAD, PDFTOTEXT, good_pdf, save_profile, upload

needs_pdf = pytest.mark.skipif(PDFTOTEXT is None, reason="xpdf pdftotext is not available")


@pytest.fixture(autouse=True)
def fast_scrypt(monkeypatch):
    monkeypatch.setattr(auth, "SCRYPT_N", 2**10)


@pytest.fixture
def db_path(tmp_path):
    return tmp_path / "var" / "app.db"


@pytest.fixture
def app(db_path):
    return create_app(Settings(environment="development", database_path=db_path))


@pytest.fixture
def world(app, db_path):
    """A firm's CA, its client with a case and profile, and that client's cookie jar."""
    ca, code = ca_with_code(app, db_path)
    client = new_client(app)
    sign_in(client, app, code["code"])
    reference = open_case(client).json()["case"]["reference"]
    assert save_profile(client, reference).status_code == 200
    yield ca, client, reference, code
    client.close(), ca.close()


def detail(ca, reference):
    return ca.get(f"/api/ca/cases/{reference}")


def prepare(ca, reference, statement_id, headers=H):
    return ca.post(f"/api/ca/cases/{reference}/review", json={"statement_id": statement_id}, headers=headers)


def uploaded(client, reference, data=CSV_OK, name="s.csv", ctype="text/csv"):
    response = upload(client, reference, data, name=name, ctype=ctype)
    return response.json()["statement"]["id"]


def stored_rows(db_path):
    return db_rows(db_path, "SELECT row_number, is_valid, category FROM statement_rows ORDER BY row_number")


# === access ======================================================================================================

def test_case_detail_before_any_review(world):
    ca, client, reference, _ = world
    statement_id = uploaded(client, reference)
    body = detail(ca, reference).json()
    assert body["case"]["reference"] == reference and body["case"]["client_email"] == "client-one@example.test"
    assert body["profile"]["full_name"] == "Asha Synthetic" and body["review"] is None
    assert [s["id"] for s in body["statements"]] == [statement_id]
    assert "storage_key" not in str(body) and "firm_id" not in str(body)


def test_unauthenticated_and_client_sessions_are_refused(app, world):
    ca, client, reference, _ = world
    statement_id = uploaded(client, reference)
    with new_client(app) as anonymous:
        assert anonymous.get(f"/api/ca/cases/{reference}").status_code == 401
        assert prepare(anonymous, reference, statement_id).status_code == 401
    assert client.get(f"/api/ca/cases/{reference}").status_code == 401  # a client cookie is not a CA session
    assert prepare(client, reference, statement_id).status_code == 401


def test_another_firm_gets_not_found(app, db_path, world):
    ca, client, reference, _ = world
    statement_id = uploaded(client, reference)
    other, _ = ca_with_code(app, db_path, "b")
    assert detail(other, reference).status_code == 404
    assert prepare(other, reference, statement_id).status_code == 404
    assert stored_rows(db_path) == []
    other.close()


@pytest.mark.parametrize("bad", ["IT-NOPE-000000", "../etc", "it-lower-abcdef", "x" * 40])
def test_unknown_or_malformed_references_are_not_found(world, bad):
    ca, _, _, _ = world
    assert detail(ca, bad).status_code == 404


@pytest.mark.parametrize("headers", [{}, {"X-ITR-Request": "1"}, {"Origin": DEV_ORIGIN},
                                     {"Origin": "https://evil.example.test", "X-ITR-Request": "1"}])
def test_prepare_needs_origin_and_csrf(world, db_path, headers):
    ca, client, reference, _ = world
    statement_id = uploaded(client, reference)
    assert prepare(ca, reference, statement_id, headers=headers).status_code == 403
    assert stored_rows(db_path) == []


# === preparing ======================================================================================================

def test_an_extracted_csv_becomes_a_verified_classified_review(world, db_path):
    ca, client, reference, _ = world
    statement_id = uploaded(client, reference)
    response = prepare(ca, reference, statement_id)
    assert response.status_code == 200
    review = response.json()["review"]
    assert review["verified"] is True and review["unverified_reasons"] == []
    assert review["statement"]["id"] == statement_id and review["classifier_version"] == case_review.CLASSIFIER_VERSION
    assert review["totals"] == {"rows": 2, "valid": 2, "invalid": 0, "needs_review": review["totals"]["needs_review"],
                                "credits": "50000.00", "debits": "250.00"}
    assert review["reconciliation"]["status"] == "passed"
    assert all(r["category"] and r["confidence"] and r["review_status"] for r in review["rows"])
    assert [(r["date"], r["debit"], r["credit"], r["balance"]) for r in review["rows"]] == [
        ("2025-04-01", "250.00", "0", "9750.00"), ("2025-04-02", "0", "50000.00", "59750.00")]
    assert response.json()["case"]["status"] == "ca_review_required"
    assert len(stored_rows(db_path)) == 2
    assert db_rows(db_path, "SELECT action FROM audit_events WHERE action = 'case.review_prepared'")


def test_a_manual_review_statement_is_never_shown_as_verified(world):
    ca, client, reference, _ = world
    statement_id = uploaded(client, reference, CSV_PARTLY_BAD)
    review = prepare(ca, reference, statement_id).json()["review"]
    assert review["statement"]["status"] == "manual_review_required"
    assert review["verified"] is False
    assert set(review["unverified_reasons"]) == {"statement_needs_manual_review", "rows_invalid",
                                                 "balance_check_not_passed"}
    assert review["totals"]["valid"] == 1 and review["totals"]["invalid"] == 2
    invalid = [r for r in review["rows"] if not r["is_valid"]]
    assert [(r["row_number"], r["issues"]) for r in invalid] == [(2, ["invalid_date"]), (3, ["debit_invalid_amount"])]
    assert all(r["category"] is None and r["narration"] is None for r in invalid)  # rejected rows carry codes only
    assert review["reconciliation"]["status"] == "incomplete"


@needs_pdf
def test_an_extracted_pdf_becomes_a_verified_review(world):
    ca, client, reference, _ = world
    statement_id = uploaded(client, reference, good_pdf(), name="s.pdf", ctype="application/pdf")
    review = prepare(ca, reference, statement_id).json()["review"]
    assert review["verified"] is True and review["totals"]["rows"] == 3


def test_preparing_again_replaces_rows_without_duplicates(world, db_path):
    ca, client, reference, _ = world
    first = uploaded(client, reference)
    second = uploaded(client, reference, CSV_PARTLY_BAD)
    prepare(ca, reference, first)
    prepare(ca, reference, first)
    assert len(stored_rows(db_path)) == 2
    body = prepare(ca, reference, second).json()
    assert body["review"]["statement"]["id"] == second and len(stored_rows(db_path)) == 3
    assert db_rows(db_path, "SELECT reviewed_upload_id FROM cases")[0][0] == second


# === refusals and failures keep previous results ===================================================================

def rows_and_case(db_path):
    return (stored_rows(db_path),
            tuple(db_rows(db_path, "SELECT reviewed_upload_id, status, version FROM cases")[0]))


@pytest.fixture
def prepared(world, db_path):
    ca, client, reference, code = world
    good = uploaded(client, reference)
    assert prepare(ca, reference, good).status_code == 200
    return ca, client, reference, good, rows_and_case(db_path)


def test_a_rejected_upload_cannot_be_prepared(prepared, db_path):
    ca, client, reference, _, before = prepared
    rejected = upload(client, reference, b"", name="empty.csv").json()["statement"]["id"]
    response = prepare(ca, reference, rejected)
    assert response.status_code == 409 and response.json()["error"] == "statement_not_usable"
    assert rows_and_case(db_path) == before


def test_an_upload_from_another_case_is_not_found(app, prepared, db_path):
    ca, client, reference, _, before = prepared
    years = client.get("/api/client/me").json()["financial_years"]
    other_ref = open_case(client, financial_year=years[0]).json()["case"]["reference"]
    save_profile(client, other_ref)
    other_statement = uploaded(client, other_ref, CSV_PARTLY_BAD)
    assert prepare(ca, reference, other_statement).status_code == 404
    assert prepare(ca, reference, "not-a-uuid").status_code == 404
    assert rows_and_case(db_path) == before


def test_a_missing_stored_file_is_refused_and_keeps_previous_rows(prepared, db_path, tmp_path):
    ca, client, reference, good, before = prepared
    second = uploaded(client, reference, CSV_PARTLY_BAD)
    key = db_rows(db_path, "SELECT d.storage_key FROM documents d JOIN statement_uploads u ON u.document_id = d.id "
                           "WHERE u.id = ?", (second,))[0][0]
    (tmp_path / "var" / "storage" / key).unlink()  # temporary test storage only
    response = prepare(ca, reference, second)
    assert response.status_code == 409 and response.json()["error"] == "file_missing"
    assert rows_and_case(db_path)[0] == before[0]


def test_a_failure_during_classification_keeps_previous_rows(app, prepared, db_path, monkeypatch):
    ca, client, reference, _, before = prepared
    second = uploaded(client, reference, CSV_PARTLY_BAD)

    def boom(*args, **kwargs):
        raise RuntimeError("SYNTHETIC-SECRET-NARRATION 999.00")

    monkeypatch.setattr(case_review, "classify_statement", boom)
    with new_client(app, raise_server_exceptions=False) as raw:
        raw.cookies.update(ca.cookies)
        response = prepare(raw, reference, second)
    assert response.status_code == 500 and "SYNTHETIC" not in response.text
    assert rows_and_case(db_path) == before


def test_a_failure_inside_the_transaction_rolls_everything_back(app, prepared, db_path, monkeypatch):
    ca, client, reference, _, before = prepared
    second = uploaded(client, reference, CSV_PARTLY_BAD)

    def fail(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(repo, "record_audit_event", fail)  # fails after the rows were replaced
    with new_client(app, raise_server_exceptions=False) as raw:
        raw.cookies.update(ca.cookies)
        assert prepare(raw, reference, second).status_code == 500
    assert rows_and_case(db_path) == before


def test_a_stale_case_is_refused_without_changes(prepared, db_path, app):
    ca, client, reference, _, before = prepared
    second = uploaded(client, reference, CSV_PARTLY_BAD)
    conn = connect(db_path)
    case = conn.execute("SELECT c.*, i.email_norm AS client_email FROM cases c JOIN client_identities i "
                        "ON i.id = c.client_identity_id").fetchone()
    stale = dict(case) | {"version": case["version"] - 1, "profile_json": {"full_name": "Asha Synthetic"}}
    with pytest.raises(repo.Conflict):
        case_review.prepare_review(conn, scope=repo.FirmScope(case["firm_id"]), case=stale, upload_id=second,
                                   actor_id="x", storage=app.state.storage, pdftotext=app.state.pdftotext)
    conn.close()
    assert rows_and_case(db_path) == before


@pytest.mark.parametrize("status, code", [("closed", "case_closed"), ("submitted", "invalid_case_status")])
def test_closed_and_other_case_states_are_refused(prepared, db_path, status, code):
    ca, client, reference, good, before = prepared
    conn = connect(db_path)
    row = conn.execute("SELECT id, firm_id, version FROM cases").fetchone()
    repo.update_case(conn, repo.FirmScope(row["firm_id"]), row["id"], expected_version=row["version"], status=status)
    conn.close()
    response = prepare(ca, reference, good)
    assert response.status_code == 409 and response.json()["error"] == code
    assert rows_and_case(db_path)[0] == before[0]


def test_review_ready_goes_back_to_ca_review_required_when_re_prepared(prepared, db_path):
    ca, client, reference, good, _ = prepared
    conn = connect(db_path)
    row = conn.execute("SELECT id, firm_id, version FROM cases").fetchone()
    repo.update_case(conn, repo.FirmScope(row["firm_id"]), row["id"], expected_version=row["version"],
                     status="review_ready")
    conn.close()
    assert prepare(ca, reference, good).json()["case"]["status"] == "ca_review_required"


@needs_pdf
def test_a_busy_extractor_refuses_without_changes(world, db_path, monkeypatch):
    ca, client, reference, _ = world
    statement_id = uploaded(client, reference, good_pdf(), name="s.pdf", ctype="application/pdf")
    monkeypatch.setattr(statements, "EXTRACTION_WAIT_SECONDS", 0.1)
    held = [statements._extraction_slots.acquire(blocking=False) for _ in range(statements.MAX_CONCURRENT_PDF_EXTRACTIONS)]
    try:
        response = prepare(ca, reference, statement_id)
    finally:
        for _ in held:
            statements._extraction_slots.release()
    assert response.status_code == 503 and response.headers["retry-after"] == "30"
    assert stored_rows(db_path) == []


def test_preparations_are_limited_per_firm(world, monkeypatch):
    ca, client, reference, _ = world
    statement_id = uploaded(client, reference)
    monkeypatch.setattr(app_module, "CASE_REVIEWS_PER_FIRM", 1)
    assert prepare(ca, reference, statement_id).status_code == 200
    assert prepare(ca, reference, statement_id, headers={**H, "X-Forwarded-For": "203.0.113.9"}).status_code == 429


def test_logs_hold_no_transaction_details(world, caplog):
    ca, client, reference, _ = world
    statement_id = uploaded(client, reference)
    with caplog.at_level(logging.DEBUG):
        prepare(ca, reference, statement_id)
    for secret in ("SYNTHETIC SHOP", "9750", "50000", "storage"):
        assert secret not in caplog.text


def test_the_database_refuses_another_cases_upload_as_the_reviewed_one(world, db_path):
    ca, client, reference, _ = world
    years = client.get("/api/client/me").json()["financial_years"]
    other_ref = open_case(client, financial_year=years[0]).json()["case"]["reference"]
    save_profile(client, other_ref)
    other_statement = uploaded(client, other_ref)
    rejected = upload(client, reference, b"", name="empty.csv").json()["statement"]["id"]
    conn = connect(db_path)
    row = conn.execute("SELECT id, firm_id, version FROM cases WHERE reference = ?", (reference,)).fetchone()
    scope = repo.FirmScope(row["firm_id"])
    for bad in (other_statement, rejected):
        version = conn.execute("SELECT version FROM cases WHERE id = ?", (row["id"],)).fetchone()[0]
        with pytest.raises(repo.InvalidInput):
            repo.update_case(conn, scope, row["id"], expected_version=version, reviewed_upload_id=bad)
    conn.close()
