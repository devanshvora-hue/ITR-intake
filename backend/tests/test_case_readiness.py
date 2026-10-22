"""Case readiness facts on the CA case list (Stage 5.10). Synthetic
statements, temporary databases and storage only."""

import itr_intake_server.case_review as case_review
import itr_intake_server.repository as repo
import itr_intake_server.statements as statements
from test_case_review import app, db_path, fast_scrypt, prepare, uploaded, world  # noqa: F401  (fixtures)
from test_client_onboarding import ca_with_code
from test_document_requests import PNG, create
from test_document_requests import upload as upload_document
from test_server_app import H, db_rows
from test_statement_uploads import CSV_PARTLY_BAD


def readiness(ca, reference):
    cases = ca.get("/api/ca/cases").json()["cases"]
    return next(c["readiness"] for c in cases if c["reference"] == reference)


def empty_documents(**changes):
    return {"required_outstanding": 0, "required_received": 0, "required_waived": 0, "optional_outstanding": 0,
            "total_requests": 0, **changes}


def test_a_new_case_has_no_statement_and_no_requests(world):
    ca, _, reference, _ = world
    assert readiness(ca, reference) == {"statement": "none", "unverified_reasons": [], "documents": empty_documents()}


def test_statement_states_follow_the_stored_review(world):
    ca, client, reference, _ = world
    good = uploaded(client, reference)
    assert readiness(ca, reference)["statement"] == "not_prepared"
    prepare(ca, reference, good)
    assert readiness(ca, reference)["statement"] == "verified"
    prepare(ca, reference, uploaded(client, reference, CSV_PARTLY_BAD))
    r = readiness(ca, reference)
    assert r["statement"] == "unverified" and "rows_invalid" in r["unverified_reasons"]


def test_document_counts_split_required_by_status(world):
    ca, client, reference, _ = world
    ids = [create(ca, reference, label=f"Required {n}").json()["request"]["id"] for n in range(3)]
    create(ca, reference, label="Optional one", required=False)
    assert upload_document(client, reference, ids[0], PNG, name="p.png", ctype="image/png").status_code == 201
    assert ca.post(f"/api/ca/cases/{reference}/document-requests/{ids[1]}/waive", headers=H).status_code == 200
    assert readiness(ca, reference)["documents"] == empty_documents(
        required_outstanding=1, required_received=1, required_waived=1, optional_outstanding=1, total_requests=4)


def test_the_case_list_only_reads_stored_data(world, db_path, monkeypatch):
    ca, client, reference, _ = world
    prepare(ca, reference, uploaded(client, reference, CSV_PARTLY_BAD))
    create(ca, reference)
    before = readiness(ca, reference)

    def forbidden(*args, **kwargs):
        raise AssertionError("the case list must not process statements")

    for module, name in [(case_review, "prepare_review"), (case_review, "classify_statement"),
                         (case_review, "_read_statement"), (case_review, "build_case_workbook"),
                         (case_review, "review_view"), (statements, "extract_pdf_pages"),
                         (statements, "_process"), (statements, "handle_upload"), (repo, "replace_statement_rows")]:
        if hasattr(module, name):
            monkeypatch.setattr(module, name, forbidden)
    snapshot = db_rows(db_path, "SELECT * FROM statement_rows ORDER BY row_number"), \
        db_rows(db_path, "SELECT id, status, version, updated_at, reviewed_at FROM cases"), \
        db_rows(db_path, "SELECT id, status, updated_at FROM document_requests")
    audit_count = db_rows(db_path, "SELECT count(*) FROM audit_events")[0][0]
    assert readiness(ca, reference) == before
    assert before["statement"] == "unverified" and before["documents"]["required_outstanding"] == 1
    assert (db_rows(db_path, "SELECT * FROM statement_rows ORDER BY row_number"),
            db_rows(db_path, "SELECT id, status, version, updated_at, reviewed_at FROM cases"),
            db_rows(db_path, "SELECT id, status, updated_at FROM document_requests")) == snapshot
    assert db_rows(db_path, "SELECT count(*) FROM audit_events")[0][0] == audit_count


def test_another_firm_never_sees_the_case(app, db_path, world):
    ca, _, reference, _ = world
    create(ca, reference)
    other, _ = ca_with_code(app, db_path, "b")
    assert other.get("/api/ca/cases").json()["cases"] == []
    other.close()
