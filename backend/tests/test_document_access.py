"""CA access to supporting documents and waive/reopen of document requests
(Stage 5.9, task 2). Synthetic files, temporary databases and storage only."""

import pytest

import itr_intake_server.app as app_module
import itr_intake_server.repository as repo
from itr_intake_server.db import connect
from test_case_review import app, db_path, fast_scrypt  # noqa: F401  (fixtures)
from test_client_onboarding import ca_with_code, open_case, sign_in
from test_document_requests import JPEG, PDF, PNG, create, requested, storage_files, upload, world  # noqa: F401
from test_server_app import DEV_ORIGIN, H, db_rows, new_client


def doc_url(reference, document_id):
    return f"/api/ca/cases/{reference}/documents/{document_id}"


def action(ca, reference, request_id, name, headers=H):
    return ca.post(f"/api/ca/cases/{reference}/document-requests/{request_id}/{name}", headers=headers)


def audit(db_path, name):
    return db_rows(db_path, f"SELECT count(*) FROM audit_events WHERE action = '{name}'")[0][0]


def status_of(ca, reference):
    return ca.get(f"/api/ca/cases/{reference}").json()["document_requests"][0]["status"]


@pytest.fixture
def uploaded(requested):
    app, ca, client, reference, request_id = requested
    assert upload(client, reference, request_id, PDF).status_code == 201
    document_id = ca.get(f"/api/ca/cases/{reference}").json()["document_requests"][0]["files"][0]["id"]
    return app, ca, client, reference, request_id, document_id


# === download =====================================================================================================

def test_a_ca_downloads_a_supporting_document_safely(uploaded, db_path):
    _, ca, _, reference, _, document_id = uploaded
    response = ca.get(doc_url(reference, document_id))
    assert response.status_code == 200 and response.content == PDF
    h = response.headers
    assert h["content-disposition"].startswith("attachment;") and "inline" not in h["content-disposition"]
    assert h["x-content-type-options"] == "nosniff" and h["cache-control"] == "no-store"
    assert h["content-security-policy"] == "sandbox" and h["content-type"] == "application/pdf"
    assert "doc.pdf" not in h["content-disposition"]  # the client's file name never reaches a header
    assert audit(db_path, "document.downloaded") == 1


def test_images_download_as_attachments_too(requested):
    _, ca, client, reference, request_id = requested
    assert upload(client, reference, request_id, PNG, name="p.png", ctype="image/png").status_code == 201
    document_id = ca.get(f"/api/ca/cases/{reference}").json()["document_requests"][0]["files"][0]["id"]
    response = ca.get(doc_url(reference, document_id))
    assert response.headers["content-type"] == "image/png"
    assert response.headers["content-disposition"].startswith("attachment")


def test_download_needs_the_owning_firms_ca(uploaded, db_path):
    app, ca, client, reference, _, document_id = uploaded
    with new_client(app) as anonymous:
        assert anonymous.get(doc_url(reference, document_id)).status_code == 401
    assert client.get(doc_url(reference, document_id)).status_code == 401  # a client cookie is not a CA session
    other, _ = ca_with_code(app, db_path, "b")
    assert other.get(doc_url(reference, document_id)).status_code == 404
    other.close()


def test_a_document_is_not_served_through_another_case(uploaded):
    _, ca, client, reference, _, document_id = uploaded
    years = client.get("/api/client/me").json()["financial_years"]
    second = open_case(client, financial_year=years[0]).json()["case"]["reference"]
    assert ca.get(doc_url(second, document_id)).status_code == 404
    assert ca.get(doc_url(reference, "not-a-uuid")).status_code == 404
    assert ca.get(doc_url(reference, "00000000-0000-4000-8000-000000000000")).status_code == 404
    assert ca.get(doc_url("IT-NOPE-000000", document_id)).status_code == 404


@pytest.mark.parametrize("kind", ["bank_statement", "workbook"])
def test_other_document_kinds_are_never_served(uploaded, db_path, kind):
    _, ca, _, reference, _, document_id = uploaded
    conn = connect(db_path)
    row = conn.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
    other = repo.add_document(conn, repo.FirmScope(row["firm_id"]), row["case_id"], kind=kind, extension="pdf",
                              display_name="s.pdf", content_type="application/pdf", size_bytes=len(PDF),
                              sha256="a" * 64, uploaded_by="system" if kind == "workbook" else "client")
    conn.close()
    assert ca.get(doc_url(reference, other["id"])).status_code == 404


def test_a_missing_file_is_not_found_and_leaks_nothing(uploaded, db_path):
    _, ca, _, reference, _, document_id = uploaded
    for f in storage_files(db_path):
        f.unlink()
    response = ca.get(doc_url(reference, document_id))
    assert response.status_code == 404 and str(db_path.parent) not in response.text


def test_downloads_are_rate_limited(uploaded, monkeypatch):
    _, ca, _, reference, _, document_id = uploaded
    monkeypatch.setattr(app_module, "DOCUMENT_DOWNLOADS_PER_FIRM", 1)
    assert ca.get(doc_url(reference, document_id)).status_code == 200
    assert ca.get(doc_url(reference, document_id)).status_code == 429


# === waive and reopen ==============================================================================================

def test_waive_and_reopen_an_empty_request(requested, db_path):
    _, ca, client, reference, request_id = requested
    response = action(ca, reference, request_id, "waive")
    assert response.status_code == 200 and response.json()["request"]["status"] == "waived"
    assert client.get("/api/client/me").json()["cases"][0]["document_requests"][0]["status"] == "waived"
    assert action(ca, reference, request_id, "reopen").json()["request"]["status"] == "requested"
    assert audit(db_path, "document_request.waived") == 1 and audit(db_path, "document_request.reopened") == 1


def test_reopening_a_request_with_files_returns_to_received(uploaded, db_path):
    _, ca, client, reference, request_id, document_id = uploaded
    assert action(ca, reference, request_id, "waive").json()["request"]["status"] == "waived"
    assert upload(client, reference, request_id, JPEG, name="j.jpg", ctype="image/jpeg").status_code == 409
    assert ca.get(doc_url(reference, document_id)).status_code == 200  # files stay reachable for the CA
    reopened = action(ca, reference, request_id, "reopen").json()["request"]
    assert reopened["status"] == "received" and len(reopened["files"]) == 1
    assert db_rows(db_path, "SELECT count(*) FROM documents WHERE kind = 'supporting'")[0][0] == 1


def test_invalid_transitions_are_refused(requested):
    _, ca, _, reference, request_id = requested
    response = action(ca, reference, request_id, "reopen")  # not waived
    assert response.status_code == 409 and response.json()["error"] == "invalid_transition"
    assert action(ca, reference, request_id, "waive").status_code == 200
    response = action(ca, reference, request_id, "waive")  # already waived
    assert response.status_code == 409 and response.json()["error"] == "invalid_transition"
    assert status_of(ca, reference) == "waived"


def test_a_closed_case_cannot_change_requests(requested, db_path):
    _, ca, _, reference, request_id = requested
    conn = connect(db_path)
    row = conn.execute("SELECT id, firm_id, version FROM cases").fetchone()
    repo.update_case(conn, repo.FirmScope(row["firm_id"]), row["id"], expected_version=row["version"], status="closed")
    conn.close()
    response = action(ca, reference, request_id, "waive")
    assert response.status_code == 409 and response.json()["error"] == "case_closed"
    assert status_of(ca, reference) == "requested"


def test_status_changes_are_authorised_and_protected(requested, db_path):
    app, ca, client, reference, request_id = requested
    with new_client(app) as anonymous:
        assert action(anonymous, reference, request_id, "waive").status_code == 401
    assert action(client, reference, request_id, "waive").status_code == 401
    other, other_code = ca_with_code(app, db_path, "b")
    assert action(other, reference, request_id, "waive").status_code == 404
    with new_client(app) as other_client:
        sign_in(other_client, app, other_code["code"], "client-b@example.test")
        other_ref = open_case(other_client).json()["case"]["reference"]
    assert action(other, other_ref, request_id, "waive").status_code == 404  # right case, foreign request
    other.close()
    years = client.get("/api/client/me").json()["financial_years"]
    second = open_case(client, financial_year=years[0]).json()["case"]["reference"]
    assert action(ca, second, request_id, "waive").status_code == 404        # own firm, wrong case
    assert action(ca, reference, "not-a-uuid", "waive").status_code == 404
    for headers in ({}, {"Origin": DEV_ORIGIN}, {"Origin": "https://evil.example.test", "X-ITR-Request": "1"}):
        assert action(ca, reference, request_id, "waive", headers=headers).status_code == 403
    assert status_of(ca, reference) == "requested"
    assert audit(db_path, "document_request.waived") == 0


def test_status_changes_are_rate_limited(requested, monkeypatch):
    _, ca, _, reference, request_id = requested
    monkeypatch.setattr(app_module, "DOCUMENT_STATUS_CHANGES_PER_FIRM", 1)
    assert action(ca, reference, request_id, "waive").status_code == 200
    assert action(ca, reference, request_id, "reopen").status_code == 429
    assert status_of(ca, reference) == "waived"
