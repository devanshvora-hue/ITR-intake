"""CA document requests and client supporting-document uploads (Stage 5.9,
task 1). Synthetic files, temporary databases and storage only."""

import logging
import re
from pathlib import Path
from urllib.parse import quote

import pytest

import itr_intake_server.app as app_module
import itr_intake_server.document_requests as doc_requests
import itr_intake_server.repository as repo
import itr_intake_server.statements as statements
import synthetic_pdf as sp
from itr_intake_server.db import connect
from test_case_review import app, db_path, fast_scrypt  # noqa: F401  (fixtures)
from test_client_onboarding import ca_with_code, open_case, sign_in
from test_server_app import DEV_ORIGIN, H, db_rows, new_client

PDF = sp.build_pdf([sp.blank_page()])
JPEG = b"\xff\xd8\xff\xe0" + b"\x00\x10JFIF\x00" + b"\x01" * 200 + b"\xff\xd9"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + b"\x02" * 60 + b"\x00\x00\x00\x00IEND\xaeB`\x82"


@pytest.fixture
def world(app, db_path):
    ca, code = ca_with_code(app, db_path)
    client = new_client(app)
    sign_in(client, app, code["code"])
    reference = open_case(client).json()["case"]["reference"]
    yield app, ca, client, reference, code
    client.close(), ca.close()


def create(ca, reference, label="Form 16 from employer", description="Please upload Form 16 for FY 2025-26.",
           required=True, headers=H):
    body = {"label": label, "required": required}
    if description is not None:
        body["description"] = description
    return ca.post(f"/api/ca/cases/{reference}/document-requests", json=body, headers=headers)


def upload(client, reference, request_id, data, name="doc.pdf", ctype="application/pdf", headers=H):
    return client.post(f"/api/client/cases/{reference}/document-requests/{request_id}/files", content=data,
                       headers={**headers, "Content-Type": ctype, "X-Upload-Filename": quote(name)})


def storage_files(db_path: Path) -> list[Path]:
    root = db_path.parent / "storage"
    return [p for p in root.rglob("*") if p.is_file()] if root.exists() else []


@pytest.fixture
def requested(world):
    app, ca, client, reference, code = world
    response = create(ca, reference)
    assert response.status_code == 201, response.text
    return app, ca, client, reference, response.json()["request"]["id"]


# === creating requests ===========================================================================================

def test_a_ca_creates_a_request_that_both_sides_can_see(world, db_path):
    _, ca, client, reference, _ = world
    response = create(ca, reference, required=False)
    view = response.json()["request"]
    assert response.status_code == 201
    assert {k: view[k] for k in ("label", "description", "required", "status", "files")} == {
        "label": "Form 16 from employer", "description": "Please upload Form 16 for FY 2025-26.", "required": False,
        "status": "requested", "files": []}
    assert ca.get(f"/api/ca/cases/{reference}").json()["document_requests"] == [view]
    mine = client.get("/api/client/me").json()["cases"][0]["document_requests"]
    assert [(r["id"], r["label"], r["required"], r["status"]) for r in mine] == [
        (view["id"], "Form 16 from employer", False, "requested")]
    key, source = db_rows(db_path, "SELECT key, source FROM document_requests")[0]
    assert re.fullmatch(r"form_16_from_employer_[0-9a-f]{6}", key) and source == "ca"
    assert db_rows(db_path, "SELECT count(*) FROM audit_events WHERE action = 'document_request.created'")[0][0] == 1


def test_the_same_label_twice_gets_distinct_keys(world, db_path):
    _, ca, _, reference, _ = world
    assert create(ca, reference).status_code == 201 and create(ca, reference).status_code == 201
    keys = [r[0] for r in db_rows(db_path, "SELECT key FROM document_requests")]
    assert len(set(keys)) == 2


@pytest.mark.parametrize("label, description, field", [
    ("A", None, "label"), ("x" * 121, None, "label"), ("Bad\u0007label", None, "label"), ("   ", None, "label"),
    ("Form 16", "y" * 501, "description"), ("Form 16", "Line\u0000break", "description"),
])
def test_request_fields_are_validated(world, label, description, field):
    _, ca, _, reference, _ = world
    response = create(ca, reference, label=label, description=description)
    assert response.status_code == 400 and response.json()["fields"] == [field]


def test_browser_supplied_keys_and_unknown_fields_are_refused(world):
    _, ca, _, reference, _ = world
    response = ca.post(f"/api/ca/cases/{reference}/document-requests", json={"label": "Form 16", "key": "pan"},
                       headers=H)
    assert response.status_code == 422


def test_only_the_firms_signed_in_ca_can_create_requests(world, db_path):
    app, ca, client, reference, _ = world
    with new_client(app) as anonymous:
        assert create(anonymous, reference).status_code == 401
    assert create(client, reference).status_code == 401  # a client cookie is not a CA session
    other, _ = ca_with_code(app, db_path, "b")
    assert create(other, reference).status_code == 404
    other.close()
    for headers in ({}, {"Origin": DEV_ORIGIN}, {"Origin": "https://evil.example.test", "X-ITR-Request": "1"}):
        assert create(ca, reference, headers=headers).status_code == 403
    assert db_rows(db_path, "SELECT count(*) FROM document_requests")[0][0] == 0


def test_a_closed_case_takes_no_new_requests(world, db_path):
    _, ca, _, reference, _ = world
    conn = connect(db_path)
    row = conn.execute("SELECT id, firm_id, version FROM cases").fetchone()
    repo.update_case(conn, repo.FirmScope(row["firm_id"]), row["id"], expected_version=row["version"], status="closed")
    conn.close()
    response = create(ca, reference)
    assert response.status_code == 409 and response.json()["error"] == "case_closed"


def test_request_creation_is_rate_limited_per_firm(world, monkeypatch):
    _, ca, _, reference, _ = world
    monkeypatch.setattr(app_module, "DOCUMENT_REQUESTS_PER_FIRM", 1)
    assert create(ca, reference).status_code == 201
    assert create(ca, reference).status_code == 429


def test_clients_see_only_their_own_requests(requested):
    app, ca, client, reference, request_id = requested
    code = ca.get("/api/ca/firm-code").json()["active"]["code"]
    with new_client(app) as other:
        sign_in(other, app, code, "client-two@example.test")
        open_case(other)
        assert all(c["document_requests"] == [] for c in other.get("/api/client/me").json()["cases"])
        assert request_id not in other.get("/api/client/me").text


# === uploading =====================================================================================================

@pytest.mark.parametrize("data, name, ctype, stored_type", [
    (PDF, "form16.pdf", "application/pdf", "application/pdf"),
    (JPEG, "photo.JPG", "image/jpeg", "image/jpeg"),
    (JPEG, "photo.jpeg", "", "image/jpeg"),
    (PNG, "scan.png", "image/png", "image/png"),
])
def test_valid_files_are_stored_privately_and_fulfil_the_request(requested, db_path, data, name, ctype, stored_type):
    _, ca, client, reference, request_id = requested
    response = upload(client, reference, request_id, data, name=name, ctype=ctype)
    assert response.status_code == 201, response.text
    assert response.json() == {"document": {"display_name": name, "content_type": stored_type,
                                            "size_bytes": len(data), "uploaded_at": response.json()["document"]["uploaded_at"]},
                               "created": True}
    files = storage_files(db_path)
    assert len(files) == 1 and files[0].read_bytes() == data and name.split(".")[0] not in files[0].name
    kind, linked = db_rows(db_path, "SELECT kind, request_id FROM documents")[0]
    assert kind == "supporting" and linked == request_id
    ca_view = ca.get(f"/api/ca/cases/{reference}").json()["document_requests"][0]
    assert ca_view["status"] == "received" and ca_view["files"][0]["display_name"] == name and "id" in ca_view["files"][0]
    client_view = client.get("/api/client/me").json()["cases"][0]["document_requests"][0]
    assert client_view["status"] == "received" and "id" not in client_view["files"][0]
    assert "storage_key" not in str(ca_view) + str(client_view)


def test_the_same_file_twice_is_stored_once(requested, db_path):
    _, _, client, reference, request_id = requested
    assert upload(client, reference, request_id, PDF).status_code == 201
    again = upload(client, reference, request_id, PDF, name="renamed.pdf")
    assert again.status_code == 200 and again.json()["created"] is False
    assert len(storage_files(db_path)) == 1 and db_rows(db_path, "SELECT count(*) FROM documents")[0][0] == 1


def test_the_same_file_for_a_different_request_is_refused(requested, db_path):
    _, ca, client, reference, request_id = requested
    second = create(ca, reference, label="Rent receipts").json()["request"]["id"]
    upload(client, reference, request_id, PDF)
    response = upload(client, reference, second, PDF)
    assert response.status_code == 409 and response.json()["error"] == "already_uploaded_for_another_request"
    assert ca.get(f"/api/ca/cases/{reference}").json()["document_requests"][1]["status"] == "requested"


def test_at_most_five_files_per_request(requested, db_path):
    _, _, client, reference, request_id = requested
    for i in range(doc_requests.MAX_FILES_PER_REQUEST):
        distinct_png = PNG + f"{i}".encode() + b"IEND"  # a different synthetic file each time
        assert upload(client, reference, request_id, distinct_png, name=f"p{i}.png", ctype="image/png").status_code == 201
    response = upload(client, reference, request_id, PDF)
    assert response.status_code == 409 and response.json()["error"] == "file_limit_reached"
    assert len(storage_files(db_path)) == doc_requests.MAX_FILES_PER_REQUEST


def test_an_oversized_body_is_refused_before_storing(requested, db_path):
    _, _, client, reference, request_id = requested
    response = upload(client, reference, request_id, b"%PDF-" + b"x" * doc_requests.MAX_DOCUMENT_BYTES)
    assert response.status_code == 413 and storage_files(db_path) == []


@pytest.mark.parametrize("data, name, ctype, code", [
    (b"", "doc.pdf", "application/pdf", "empty_file"),
    (b"hello", "notes.txt", "text/plain", "unsupported_file_type"),
    (b"Date,Narration\n", "list.csv", "text/csv", "unsupported_file_type"),
    (b"<html><script>x</script></html>", "page.html", "text/html", "unsupported_file_type"),
    (b"MZ\x90\x00", "tool.exe", "application/octet-stream", "unsupported_file_type"),
    (b"PK\x03\x04zipdata", "archive.zip", "application/zip", "unsupported_file_type"),
    (b"no extension", "document", "application/pdf", "unsupported_file_type"),
    (PDF, "doc.png", "image/png", "type_mismatch"),
    (PNG, "doc.pdf", "application/pdf", "type_mismatch"),
    (JPEG, "doc.png", "image/png", "type_mismatch"),
    (PDF, "doc.pdf", "image/png", "type_mismatch"),
    (PNG, "doc.png", "image/gif", "type_mismatch"),
    (b"<html>%PDF-1.4 %%EOF", "doc.pdf", "application/pdf", "type_mismatch"),
    (PDF[: len(PDF) // 2], "doc.pdf", "application/pdf", "truncated_file"),
    (JPEG[:-2], "doc.jpg", "image/jpeg", "truncated_file"),
    (PNG[:-12], "doc.png", "image/png", "truncated_file"),
], ids=lambda v: v if isinstance(v, str) and len(v) < 30 else "data")
def test_bad_files_are_refused_and_nothing_changes(requested, db_path, data, name, ctype, code):
    _, ca, client, reference, request_id = requested
    response = upload(client, reference, request_id, data, name=name, ctype=ctype)
    assert response.status_code == 422 and response.json()["error"] == code
    assert storage_files(db_path) == [] and db_rows(db_path, "SELECT count(*) FROM documents")[0][0] == 0
    assert ca.get(f"/api/ca/cases/{reference}").json()["document_requests"][0]["status"] == "requested"


def test_a_waived_request_takes_no_files(requested, db_path):
    _, _, client, reference, request_id = requested
    conn = connect(db_path)
    row = conn.execute("SELECT case_id, firm_id FROM document_requests").fetchone()
    repo.set_document_request_status(conn, repo.FirmScope(row["firm_id"]), row["case_id"], request_id, "waived")
    conn.close()
    response = upload(client, reference, request_id, PDF)
    assert response.status_code == 409 and response.json()["error"] == "request_waived"
    assert storage_files(db_path) == []


# === authorisation ==================================================================================================

def test_uploads_are_limited_to_the_owning_client_and_case(requested, db_path):
    app, ca, client, reference, request_id = requested
    code = ca.get("/api/ca/firm-code").json()["active"]["code"]
    with new_client(app) as other:
        sign_in(other, app, code, "client-two@example.test")
        other_ref = open_case(other).json()["case"]["reference"]
        assert upload(other, reference, request_id, PDF).status_code == 404       # someone else's case
        assert upload(other, other_ref, request_id, PDF).status_code == 404       # own case, foreign request
    years = client.get("/api/client/me").json()["financial_years"]
    second_ref = open_case(client, financial_year=years[0]).json()["case"]["reference"]
    assert upload(client, second_ref, request_id, PDF).status_code == 404         # own other case
    assert upload(client, reference, "not-a-uuid", PDF).status_code == 404
    assert upload(client, reference, "00000000-0000-4000-8000-000000000000", PDF).status_code == 404
    with new_client(app) as anonymous:
        assert upload(anonymous, reference, request_id, PDF).status_code == 401
    assert upload(ca, reference, request_id, PDF).status_code == 401              # a CA cookie is not a client
    for headers in ({}, {"Origin": DEV_ORIGIN}, {"Origin": "https://evil.example.test", "X-ITR-Request": "1"}):
        assert upload(client, reference, request_id, PDF, headers=headers).status_code == 403
    assert storage_files(db_path) == []


def test_another_firms_request_is_not_found(app, db_path, requested):
    _, _, client, reference, _ = requested
    other_ca, other_code = ca_with_code(app, db_path, "b")
    with new_client(app) as other_client:
        sign_in(other_client, app, other_code["code"], "client-b@example.test")
        other_ref = open_case(other_client).json()["case"]["reference"]
        foreign = create(other_ca, other_ref).json()["request"]["id"]
    assert upload(client, reference, foreign, PDF).status_code == 404
    other_ca.close()


def test_uploads_are_rate_limited_per_client(requested, monkeypatch):
    _, _, client, reference, request_id = requested
    monkeypatch.setattr(app_module, "CLIENT_DOCUMENT_UPLOADS_PER_CLIENT", 1)
    assert upload(client, reference, request_id, PDF).status_code == 201
    assert upload(client, reference, request_id, PNG, name="p.png", ctype="image/png",
                  headers={**H, "X-Forwarded-For": "203.0.113.5"}).status_code == 429


def test_no_route_serves_the_files(requested, app):
    _, _, client, reference, request_id = requested
    upload(client, reference, request_id, PDF)
    assert client.get(f"/api/client/cases/{reference}/document-requests/{request_id}/files").status_code == 405
    assert not any(getattr(r, "path", "").startswith("/api/client") and "GET" in getattr(r, "methods", set())
                   and ("download" in r.path or "documents" in r.path) for r in app.routes)


# === failures leave nothing behind ===================================================================================

@pytest.mark.parametrize("target", ["promote", "audit"])
def test_a_failure_while_storing_leaves_no_file_record_or_status_change(requested, db_path, monkeypatch, target):
    app, ca, client, reference, request_id = requested

    def fail(*args, **kwargs):
        raise OSError("disk full")

    if target == "promote":
        monkeypatch.setattr(statements.Storage, "promote", fail)
    else:
        monkeypatch.setattr(repo, "record_audit_event", fail)
    with new_client(app, raise_server_exceptions=False) as raw:
        raw.cookies.update(client.cookies)
        response = upload(raw, reference, request_id, PDF)
    assert response.status_code == 500 and response.json()["error"] == "internal_error"
    monkeypatch.undo()
    assert storage_files(db_path) == []
    assert db_rows(db_path, "SELECT count(*) FROM documents")[0][0] == 0
    assert ca.get(f"/api/ca/cases/{reference}").json()["document_requests"][0]["status"] == "requested"


def test_logs_hold_no_names_or_contents(requested, caplog):
    _, _, client, reference, request_id = requested
    with caplog.at_level(logging.DEBUG):
        upload(client, reference, request_id, PDF, name="Asha-private-form16.pdf")
    assert "Asha-private" not in caplog.text and "storage" not in caplog.text.lower()
