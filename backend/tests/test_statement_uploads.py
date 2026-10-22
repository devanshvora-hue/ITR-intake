"""Client profile and statement uploads over HTTP (Stage 5.7): validation,
private storage, ownership, firm isolation, limits, failures and logs.
Synthetic files, temporary databases and temporary storage only."""

import hashlib
import logging
from pathlib import Path
from urllib.parse import quote

import pytest

import itr_intake_server.app as app_module
import itr_intake_server.ca_auth as auth
import itr_intake_server.statements as statements
import synthetic_pdf as sp
from itr_intake import statement_import as si
from itr_intake_server.app import create_app
from itr_intake_server.db import MIGRATIONS_DIR, connect
from itr_intake_server.settings import Settings
from test_client_onboarding import ca_with_code, open_case, sign_in
from test_server_app import DEV_ORIGIN, H, db_rows, new_client

CSV_OK = (b"Date,Narration,Debit,Credit,Balance\n"
          b"01/04/2025,UPI/1001/SYNTHETIC SHOP,250.00,,9750.00\n"
          b"02/04/2025,NEFT SALARY SYNTHETIC CO,,50000.00,59750.00\n")
CSV_PARTLY_BAD = (b"Date,Narration,Debit,Credit,Balance\n"
                  b"01/04/2025,SYNTHETIC A,10.00,,990.00\n"
                  b"31/02/2025,SYNTHETIC B,10.00,,980.00\n"
                  b"03/04/2025,SYNTHETIC C,abc,,970.00\n")
PROFILE = {"full_name": "Asha Synthetic", "bank_name": "Synthetic Bank Ltd", "account_last4": "1234"}
PDFTOTEXT = statements.find_pdftotext()
needs_pdf = pytest.mark.skipif(PDFTOTEXT is None, reason="xpdf pdftotext is not available")


@pytest.fixture(autouse=True)
def fast_scrypt(monkeypatch):
    monkeypatch.setattr(auth, "SCRYPT_N", 2**10)


@pytest.fixture
def db_path(tmp_path):
    return tmp_path / "var" / "app.db"


@pytest.fixture
def storage_root(tmp_path):
    return tmp_path / "var" / "storage"


@pytest.fixture
def app(db_path):
    return create_app(Settings(environment="development", database_path=db_path))


@pytest.fixture
def firm(app, db_path):
    ca, code = ca_with_code(app, db_path)
    yield ca, code
    ca.close()


def client_with_case(app, code, email="client-one@example.test"):
    c = new_client(app)
    sign_in(c, app, code["code"], email)
    reference = open_case(c).json()["case"]["reference"]
    return c, reference


@pytest.fixture
def client(app, firm):
    c, reference = client_with_case(app, firm[1])
    yield c, reference
    c.close()


def save_profile(c, reference, body=None, headers=H):
    return c.post(f"/api/client/cases/{reference}/profile", json=PROFILE if body is None else body, headers=headers)


def upload(c, reference, data, name="statement.csv", ctype="text/csv", headers=H):
    return c.post(f"/api/client/cases/{reference}/statements", content=data,
                  headers={**headers, "Content-Type": ctype, "X-Upload-Filename": quote(name)})


@pytest.fixture
def ready(client):
    c, reference = client
    assert save_profile(c, reference).status_code == 200
    return c, reference


def stored_files(root: Path) -> list[Path]:
    return [p for p in root.rglob("*") if p.is_file()] if root.exists() else []


def good_pdf() -> bytes:
    return sp.build_pdf([
        sp.statement_page([("01/04/2025", "UPI/100001/SYNTHETIC GROCER", "1,250.00", "", "48,750.00"),
                           ("03/04/2025", "NEFT SALARY SYNTHETIC CO", "", "85,000.00", "1,33,750.00")],
                          opening="50,000.00", page_no=1),
        sp.statement_page([("05/04/2025", "ATM WDL SYNTHETIC BRANCH", "5,000.00", "", "1,28,750.00")],
                          closing="1,28,750.00", page_no=2)], compress=True)


# === profile ==============================================================================================

def test_profile_is_created_and_updated(client):
    c, reference = client
    first = save_profile(c, reference)
    assert first.status_code == 200
    assert first.json()["profile"] == {**PROFILE, "complete": True}
    second = save_profile(c, reference, {"full_name": "  Asha   Synthetic-Rao ", "bank_name": "Synthetic Bank Ltd"})
    assert second.json()["profile"] == {"full_name": "Asha Synthetic-Rao", "bank_name": "Synthetic Bank Ltd",
                                        "account_last4": None, "complete": True}
    me = c.get("/api/client/me").json()["cases"][0]
    assert me["profile"]["full_name"] == "Asha Synthetic-Rao" and me["financial_year"]


@pytest.mark.parametrize("body, field", [
    ({"bank_name": "Synthetic Bank"}, "full_name"),
    ({"full_name": "Asha"}, "bank_name"),
    ({**PROFILE, "full_name": "A"}, "full_name"),
    ({**PROFILE, "full_name": "Asha 123"}, "full_name"),
    ({**PROFILE, "full_name": "<script>x</script>"}, "full_name"),
    ({**PROFILE, "full_name": "x" * 101}, "full_name"),
    ({**PROFILE, "bank_name": "Bank\u0000"}, "bank_name"),
    ({**PROFILE, "account_last4": "12345"}, "account_last4"),
    ({**PROFILE, "account_last4": "12a4"}, "account_last4"),
    ({**PROFILE, "account_last4": "123"}, "account_last4"),
    ({**PROFILE, "financial_year": "2010-11"}, "financial_year"),
])
def test_profile_fields_are_validated(client, body, field):
    c, reference = client
    response = save_profile(c, reference, body)
    assert response.status_code == 400 and field in response.json()["fields"]
    for value in body.values():
        if isinstance(value, str) and len(value) > 3:
            assert value not in response.text


@pytest.mark.parametrize("extra", [{"pan": "ABCDE1234F"}, {"account_number": "123456789012"}, {"aadhaar": "1"},
                                   {"full_name": 12345}])
def test_unknown_or_sensitive_fields_are_refused(client, extra):
    c, reference = client
    response = save_profile(c, reference, {**PROFILE, **extra})
    assert response.status_code == 422 and "ABCDE1234F" not in response.text and "123456789012" not in response.text


def test_the_financial_year_must_be_the_cases_own(client):
    c, reference = client
    fy = c.get("/api/client/me").json()["cases"][0]["financial_year"]
    assert save_profile(c, reference, {**PROFILE, "financial_year": fy}).status_code == 200


def test_profile_needs_a_signed_in_owner(app, firm, client):
    c, reference = client
    with new_client(app) as anonymous:
        assert save_profile(anonymous, reference).status_code == 401
    other, _ = client_with_case(app, firm[1], "client-two@example.test")
    assert save_profile(other, reference).status_code == 404  # someone else's reference
    assert save_profile(other, "IT-NOPE-000000").status_code == 404
    assert save_profile(other, "../../etc").status_code == 404
    other.close()


@pytest.mark.parametrize("headers", [{}, {"Origin": DEV_ORIGIN}, {"Origin": "https://evil.example.test", "X-ITR-Request": "1"}])
def test_profile_and_upload_need_origin_and_csrf(ready, headers, storage_root):
    c, reference = ready
    assert save_profile(c, reference, headers=headers).status_code == 403
    assert upload(c, reference, CSV_OK, headers=headers).status_code == 403
    assert stored_files(storage_root) == []


def test_an_expired_session_cannot_change_anything(ready, db_path):
    c, reference = ready
    conn = connect(db_path)
    conn.execute("UPDATE sessions SET idle_expires_at = '2000-01-01T00:00:00.000000Z' WHERE kind = 'client'")
    conn.close()
    assert save_profile(c, reference).status_code == 401
    assert upload(c, reference, CSV_OK).status_code == 401


def test_open_case_rules_still_hold(ready):
    c, reference = ready
    again = open_case(c)
    assert again.status_code == 200 and again.json()["case"]["reference"] == reference


# === CSV uploads ============================================================================================

def test_upload_requires_a_complete_profile(client, storage_root):
    c, reference = client
    response = upload(c, reference, CSV_OK)
    assert response.status_code == 409 and response.json()["error"] == "profile_required"
    assert stored_files(storage_root) == []


def test_a_valid_csv_is_stored_privately_and_extracted(ready, db_path, storage_root):
    c, reference = ready
    response = upload(c, reference, CSV_OK, name="My April Statement.csv")
    assert response.status_code == 201
    view = response.json()["statement"]
    assert view["status"] == "extracted" and view["rows_extracted"] == 2 and view["rows_rejected"] == 0
    assert view["display_name"] == "My April Statement.csv" and view["file_type"] == "csv"
    assert view["period_start"] == "2025-04-01" and "storage_key" not in str(response.json())
    files = stored_files(storage_root)
    assert len(files) == 1 and files[0].read_bytes() == CSV_OK
    key = db_rows(db_path, "SELECT storage_key, sha256 FROM documents")[0]
    assert files[0] == (storage_root / key[0]).resolve() or files[0].resolve() == (storage_root / key[0]).resolve()
    assert Path(key[0]).name != "My April Statement.csv" and key[1] == hashlib.sha256(CSV_OK).hexdigest()
    assert c.get("/api/client/me").json()["cases"][0]["statements"][0]["status"] == "extracted"
    assert c.get("/api/client/me").json()["cases"][0]["status"] == "statement_uploaded"  # not "ready for review"


def test_a_partly_bad_csv_is_stored_but_needs_review(ready):
    c, reference = ready
    view = upload(c, reference, CSV_PARTLY_BAD).json()["statement"]
    assert view["status"] == "manual_review_required" and view["rows_extracted"] == 1 and view["rows_rejected"] == 2
    assert view["rejected_rows"] == [{"row": 2, "codes": ["invalid_date"]}, {"row": 3, "codes": ["debit_invalid_amount"]}]
    assert "rows_rejected" in view["reasons"]
    assert "SYNTHETIC B" not in str(view)  # row numbers and codes only


def test_repeating_the_same_upload_returns_the_first(ready, db_path, storage_root):
    c, reference = ready
    first = upload(c, reference, CSV_OK)
    second = upload(c, reference, CSV_OK, name="renamed.csv")
    assert first.status_code == 201 and second.status_code == 200 and second.json()["created"] is False
    assert second.json()["statement"]["id"] == first.json()["statement"]["id"]
    assert len(stored_files(storage_root)) == 1
    assert db_rows(db_path, "SELECT count(*) FROM statement_uploads")[0][0] == 1


@pytest.mark.parametrize("data, name, ctype, code", [
    (b"", "s.csv", "text/csv", "empty_file"),
    (CSV_OK, "s.txt", "text/plain", "unsupported_file_type"),
    (CSV_OK, "s.exe", "application/octet-stream", "unsupported_file_type"),
    (CSV_OK, "s", "text/csv", "unsupported_file_type"),
    (b"%PDF-1.4\n%%EOF\n", "s.csv", "text/csv", "type_mismatch"),
    (CSV_OK, "s.pdf", "application/pdf", "type_mismatch"),
    (CSV_OK, "s.csv", "image/png", "type_mismatch"),
    (b"\x89PNG\r\n\x1a\n" + b"0" * 50, "s.csv", "text/csv", "unsupported_content"),
    (b"PK\x03\x04" + b"0" * 50, "s.csv", "text/csv", "unsupported_content"),
    (b"Date,Narration\n" + b"x" * (statements.MAX_CSV_BYTES + 1), "s.csv", "text/csv", "file_too_large"),
    ("Date,Narration,Debit\n01/04/2025,CAF\xe9,1.00\n".encode("latin-1"), "s.csv", "text/csv", "unsupported_encoding"),
    (b"When,What\n1,2\n", "s.csv", "text/csv", "missing_required_columns"),
], ids=lambda v: v if isinstance(v, str) and len(v) < 40 else "data")
def test_bad_files_are_rejected_and_never_stored(ready, db_path, storage_root, data, name, ctype, code):
    c, reference = ready
    response = upload(c, reference, data, name=name, ctype=ctype)
    assert response.status_code == 422
    view = response.json()["statement"]
    assert view["status"] == "rejected" and view["error_code"] == code and view["rows_extracted"] == 0
    assert stored_files(storage_root) == [] or all(".staging" not in str(p) for p in stored_files(storage_root))
    assert stored_files(storage_root) == []
    assert db_rows(db_path, "SELECT count(*) FROM documents")[0][0] == 0
    assert c.get("/api/client/me").json()["cases"][0]["status"] == "draft"


def test_an_oversized_body_is_refused_before_processing(ready, storage_root):
    c, reference = ready
    response = upload(c, reference, b"x" * (statements.MAX_UPLOAD_BYTES + 1))
    assert response.status_code == 413 and stored_files(storage_root) == []


def test_path_traversal_names_are_display_only(ready, db_path, storage_root):
    c, reference = ready
    view = upload(c, reference, CSV_OK, name="..\\..\\..\\windows/../etc/passwd<>.csv").json()["statement"]
    assert view["display_name"] == "passwd_.csv"
    for f in stored_files(storage_root):
        assert f.resolve().is_relative_to(storage_root.resolve()) and "passwd" not in f.name
    key = db_rows(db_path, "SELECT storage_key FROM documents")[0][0]
    assert ".." not in key and "passwd" not in key


def test_storage_refuses_bad_keys_and_symlinks(tmp_path):
    store = statements.Storage(tmp_path / "root")
    for key in ("../x.pdf", "a/b/c.pdf", "", "00000000-0000-4000-8000-000000000000/../x.pdf"):
        with pytest.raises(statements.StorageError):
            store.path_for(key)
    outside = tmp_path / "outside"
    outside.mkdir()
    link = tmp_path / "root" / "11111111-1111-4111-8111-111111111111"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks are not permitted for this user on this system")
    with pytest.raises(statements.StorageError):
        store.path_for("11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/"
                       "33333333-3333-4333-8333-333333333333.pdf")


def test_staging_cleanup_only_touches_old_staging_files(tmp_path):
    store = statements.Storage(tmp_path / "root")
    staged = store.stage(b"x", "csv")
    keep = tmp_path / "root" / "unrelated.txt"
    keep.write_text("keep")
    assert store.clean_staging() == 0 and staged.exists()
    import os
    os.utime(staged, (0, 0))
    assert store.clean_staging() == 1 and not staged.exists() and keep.exists()


def test_the_per_case_statement_limit(ready, monkeypatch):
    c, reference = ready
    monkeypatch.setattr(statements, "MAX_STORED_STATEMENTS_PER_CASE", 2)
    for i in range(2):
        assert upload(c, reference, CSV_OK.replace(b"SHOP", f"SHOP{i}".encode())).status_code == 201
    third = upload(c, reference, CSV_OK.replace(b"SHOP", b"SHOP3"))
    assert third.status_code == 409 and third.json()["error"] == "upload_limit_reached"


def test_uploads_are_rate_limited_per_client(ready, monkeypatch):
    c, reference = ready
    monkeypatch.setattr(app_module, "CLIENT_UPLOADS_PER_CLIENT", 2)
    statuses = [upload(c, reference, CSV_OK, headers={**H, "X-Forwarded-For": f"203.0.113.{i}"}).status_code
                for i in range(3)]
    assert statuses == [201, 200, 429]


# === PDF uploads ============================================================================================

@needs_pdf
def test_a_valid_pdf_is_extracted(ready, storage_root):
    c, reference = ready
    response = upload(c, reference, good_pdf(), name="statement.pdf", ctype="application/pdf")
    view = response.json()["statement"]
    assert response.status_code == 201 and view["status"] == "extracted", view
    assert view["rows_extracted"] == 3 and view["pages_total"] == 2 and view["page_warnings"] == []
    assert len(stored_files(storage_root)) == 1  # no extracted-text files left behind


@needs_pdf
def test_an_image_only_pdf_needs_manual_review(ready):
    c, reference = ready
    data = sp.build_pdf([sp.image_only_page(), sp.image_only_page()])
    view = upload(c, reference, data, name="scan.pdf", ctype="application/pdf").json()["statement"]
    assert view["status"] == "manual_review_required" and view["rows_extracted"] == 0
    assert {w["page"] for w in view["page_warnings"]} == {1, 2}
    assert "image_content_not_extracted" in view["reasons"]


@needs_pdf
def test_a_mixed_pdf_keeps_partial_rows_but_is_never_complete(ready):
    c, reference = ready
    data = sp.build_pdf([sp.statement_page([("01/04/2025", "UPI SYNTHETIC", "10.00", "", "990.00")], opening="1,000.00"),
                         sp.mixed_page()])
    view = upload(c, reference, data, name="mixed.pdf", ctype="application/pdf").json()["statement"]
    assert view["status"] == "manual_review_required" and view["rows_extracted"] == 1
    assert {"page": 2, "code": "no_transactions_on_page"} in view["page_warnings"]


@needs_pdf
def test_an_unreadable_pdf_is_rejected_and_not_kept(ready, storage_root):
    c, reference = ready
    response = upload(c, reference, b"%PDF-1.4\nnot really a pdf\n%%EOF\n", name="x.pdf", ctype="application/pdf")
    view = response.json()["statement"]
    assert response.status_code == 422 and view["status"] == "rejected" and view["error_code"] == "pdf_unreadable"
    assert stored_files(storage_root) == []


def test_a_truncated_pdf_is_rejected(ready, storage_root):
    c, reference = ready
    data = sp.build_pdf([sp.blank_page()])
    view = upload(c, reference, data[:-20], name="x.pdf", ctype="application/pdf").json()["statement"]
    assert view["error_code"] == "truncated_pdf" and stored_files(storage_root) == []


def test_without_an_extractor_a_pdf_is_kept_for_manual_review(db_path, tmp_path):
    app = create_app(Settings(environment="development", database_path=db_path,
                              pdftotext_path=str(tmp_path / "missing-pdftotext.exe")))
    assert app.state.pdftotext is None
    ca, code = ca_with_code(app, db_path)
    c, reference = client_with_case(app, code)
    save_profile(c, reference)
    view = upload(c, reference, sp.build_pdf([sp.blank_page()]), name="s.pdf", ctype="application/pdf").json()["statement"]
    assert view["status"] == "manual_review_required" and view["reasons"] == ["pdf_extractor_unavailable"]
    c.close(), ca.close()


# === failures and consistency ===================================================================================

def test_a_parser_crash_is_recorded_safely(ready, storage_root, monkeypatch, caplog):
    c, reference = ready

    def boom(*args, **kwargs):
        raise RuntimeError("SECRET-ROW-CONTENT 9999.00")

    monkeypatch.setattr(si, "parse_csv", boom)
    with caplog.at_level(logging.DEBUG):
        response = upload(c, reference, CSV_OK)
    view = response.json()["statement"]
    assert view["status"] == "processing_failed" and view["error_code"] == "unexpected_error"
    assert "SECRET" not in response.text and "SECRET" not in caplog.text
    assert len(stored_files(storage_root)) == 1  # kept for a later retry; no staging file remains


def test_a_storage_failure_leaves_no_record_and_no_file(ready, db_path, storage_root, monkeypatch, app):
    c, reference = ready

    def fail(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(statements.Storage, "promote", fail)
    with new_client(app, raise_server_exceptions=False) as raw:
        raw.cookies.update(c.cookies)
        response = upload(raw, reference, CSV_OK)
    assert response.status_code == 500 and response.json() == {"error": "internal_error", "message": "Something went wrong."}
    assert db_rows(db_path, "SELECT count(*) FROM documents")[0][0] == 0
    assert db_rows(db_path, "SELECT count(*) FROM statement_uploads")[0][0] == 0
    assert stored_files(storage_root) == []
    assert c.get("/api/client/me").json()["cases"][0]["status"] == "draft"


def test_a_document_of_another_case_cannot_be_linked(ready, db_path):
    import itr_intake_server.repository as repo
    c, reference = ready
    upload(c, reference, CSV_OK)
    conn = connect(db_path)
    doc = conn.execute("SELECT id, case_id, firm_id FROM documents").fetchone()
    scope = repo.FirmScope(doc["firm_id"])
    identity = repo.get_or_create_client_identity(conn, scope, "client-x@example.test")
    other = repo.create_case(conn, scope, client_identity_id=identity["id"], first_name="Other", financial_year="2024-25")
    with pytest.raises(repo.InvalidInput):
        repo.create_statement_upload(conn, scope, other["id"], file_type="csv", display_name="x.csv", size_bytes=1,
                                     status="extracted", document_id=doc["id"])
    conn.close()


# === isolation and the CA view ===================================================================================

def test_clients_cannot_reach_each_others_uploads(app, firm, ready):
    c, reference = ready
    upload(c, reference, CSV_OK)
    other, other_ref = client_with_case(app, firm[1], "client-two@example.test")
    save_profile(other, other_ref)
    assert upload(other, reference, CSV_OK).status_code == 404  # the first client's case
    me = other.get("/api/client/me").json()
    assert [s for case in me["cases"] for s in case["statements"]] == []
    assert reference not in str(me)
    other.close()


def test_there_is_no_route_that_serves_files(app, ready):
    c, reference = ready
    statement_id = upload(c, reference, CSV_OK).json()["statement"]["id"]
    for path in (f"/api/client/cases/{reference}/statements", f"/api/client/cases/{reference}/statements/{statement_id}",
                 f"/api/ca/statements/{statement_id}", "/storage", "/var/storage"):
        assert c.get(path).status_code in (404, 405)
    assert not any("download" in getattr(r, "path", "") for r in app.routes)


def test_the_ca_sees_their_own_firms_uploads_only(app, db_path, firm, ready):
    ca, _ = firm
    c, reference = ready
    upload(c, reference, CSV_OK)
    upload(c, reference, CSV_PARTLY_BAD)
    upload(c, reference, b"", name="empty.csv")
    listed = ca.get("/api/ca/statements").json()["statements"]
    assert [s["status"] for s in listed] == ["rejected", "manual_review_required", "extracted"]
    assert all(s["case_reference"] == reference and s["bank_name"] == "Synthetic Bank Ltd" for s in listed)
    assert listed[1]["rows_rejected"] == 2 and listed[2]["rows_extracted"] == 2
    assert "storage_key" not in str(listed) and "9750" not in str(listed)
    cases = ca.get("/api/ca/cases").json()["cases"]
    assert cases[0]["profile"]["bank_name"] == "Synthetic Bank Ltd" and cases[0]["status"] == "statement_uploaded"

    other_ca, other_code = ca_with_code(app, db_path, "b")
    assert other_ca.get("/api/ca/statements").json() == {"statements": []}
    other_ca.close()
    with new_client(app) as anonymous:
        assert anonymous.get("/api/ca/statements").status_code == 401
        assert anonymous.post(f"/api/client/cases/{reference}/statements", content=CSV_OK, headers=H).status_code == 401


def test_logs_hold_no_file_contents_or_names(ready, caplog):
    c, reference = ready
    with caplog.at_level(logging.DEBUG):
        upload(c, reference, CSV_OK, name="Asha-private-statement.csv")
        upload(c, reference, CSV_PARTLY_BAD)
    for secret in ("SYNTHETIC SHOP", "9750", "Asha-private", "SYNTHETIC B", "storage"):
        assert secret not in caplog.text


# === migrations =====================================================================================================

def test_applied_migrations_are_unchanged():
    expected = {
        "0001_initial_schema.sql": "90452c1d385fd0e5bd08dd703e13825c66b83b49641d029d35da9583d1fdb1e3",
        "0002_email_worker.sql": "eba57ba1246eab75fed60bf615a7a701ac6b274c800e3613364801b07d132666",
        "0003_client_onboarding.sql": "190e899a541acd447deb61abcf18b99de6fcba59981490b69a258a7ec218fb43",
        "0004_statement_uploads.sql": "32c8baf69f617fe98bf55796f38ee8e8e442367ea75fc81b23884a5bbba92394",
        "0005_case_review.sql": "c9360062adef6d79b0f3d29ee74144522ef5099d7c891a4741934ee0e144f972",
    }
    for name, digest in expected.items():
        assert hashlib.sha256((MIGRATIONS_DIR / name).read_bytes()).hexdigest() == digest
    assert sorted(p.name for p in MIGRATIONS_DIR.glob("*.sql"))[-1] == "0006_document_requests.sql"
