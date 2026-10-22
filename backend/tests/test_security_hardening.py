"""Stage 5.7.1 hardening: link-safe storage (Windows junctions), PDF
extraction resource limits and concurrency, and the resend-verification
limit. Synthetic files, temporary storage and databases only."""

import subprocess
from pathlib import Path
from urllib.parse import quote

import pytest

import itr_intake_server.app as app_module
import itr_intake_server.ca_auth as auth
import itr_intake_server.statements as statements
import synthetic_pdf as sp
from itr_intake_server.app import create_app
from itr_intake_server.settings import Settings
from test_client_onboarding import ca_with_code, open_case, sign_in
from test_server_app import H, db_rows, messages, new_client, register

PDFTOTEXT = statements.find_pdftotext()
needs_pdf = pytest.mark.skipif(PDFTOTEXT is None, reason="xpdf pdftotext is not available")
KEY = ("11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/"
       "33333333-3333-4333-8333-333333333333.pdf")


@pytest.fixture(autouse=True)
def fast_scrypt(monkeypatch):
    monkeypatch.setattr(auth, "SCRYPT_N", 2**10)


def make_junction(link: Path, target: Path) -> None:
    """A Windows directory junction (no admin rights needed); skip elsewhere."""
    try:
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        pytest.skip("junctions cannot be created here")
    if result.returncode != 0 or not link.is_junction():
        pytest.skip("junctions cannot be created here")


def remove_junction(link: Path) -> None:
    if link.is_junction():
        subprocess.run(["cmd", "/c", "rmdir", str(link)], capture_output=True, timeout=10)


# === storage links ==========================================================================================

def test_a_junction_inside_storage_is_refused_and_nothing_is_created_through_it(tmp_path):
    root, outside = tmp_path / "root", tmp_path / "outside"
    root.mkdir(), outside.mkdir()
    link = root / KEY.split("/")[0]
    make_junction(link, outside)
    try:
        with pytest.raises(statements.StorageError):
            statements.Storage(root).path_for(KEY)
        assert list(outside.iterdir()) == []  # no directory was created on the other side
    finally:
        remove_junction(link)


def test_a_junction_as_the_staging_folder_is_refused(tmp_path):
    root, outside = tmp_path / "root", tmp_path / "outside"
    root.mkdir(), outside.mkdir()
    link = root / ".staging"
    make_junction(link, outside)
    try:
        with pytest.raises(statements.StorageError):
            statements.Storage(root).stage(b"synthetic", "csv")
        assert list(outside.iterdir()) == []
    finally:
        remove_junction(link)


def test_a_junction_as_the_storage_root_is_refused(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    link = tmp_path / "root"
    make_junction(link, outside)
    try:
        with pytest.raises(statements.StorageError):
            statements.Storage(link).stage(b"synthetic", "csv")
        assert list(outside.iterdir()) == []
    finally:
        remove_junction(link)


def test_a_file_in_place_of_a_storage_folder_is_refused(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    (root / KEY.split("/")[0]).write_text("not a folder")
    with pytest.raises(statements.StorageError):
        statements.Storage(root).path_for(KEY)


# === PDF extraction limits ====================================================================================

def heavy_pdf(lines: int) -> bytes:
    """A small synthetic PDF whose single page takes pdftotext a long time."""
    page = sp.Page()
    page.ops = ["BT /F1 9 Tf 40 500 Td (" + "SYNTHETICLOADTEXT " * 40 + ") Tj ET"] * lines
    return sp.build_pdf([page], compress=True)


@needs_pdf
def test_text_output_over_the_cap_is_refused_and_removed(tmp_path, monkeypatch):
    monkeypatch.setattr(statements, "MAX_PDF_TEXT_BYTES", 10)
    pdf = tmp_path / "s.pdf"
    pdf.write_bytes(sp.build_pdf([sp.statement_page([("01/04/2025", "SYNTHETIC", "1.00", "", "9.00")])]))
    with pytest.raises(statements.ExtractionFailed) as exc:
        statements.extract_pdf_pages(PDFTOTEXT, pdf, tmp_path)
    assert exc.value.code == "pdf_text_too_large"
    assert [p.name for p in tmp_path.iterdir()] == ["s.pdf"]


@needs_pdf
def test_a_slow_pdf_is_stopped_at_the_timeout(tmp_path, monkeypatch):
    monkeypatch.setattr(statements, "PDF_TIMEOUT_SECONDS", 1)
    pdf = tmp_path / "heavy.pdf"
    pdf.write_bytes(heavy_pdf(20_000))
    with pytest.raises(statements.ExtractionFailed) as exc:
        statements.extract_pdf_pages(PDFTOTEXT, pdf, tmp_path)
    assert exc.value.code == "pdf_timeout"
    assert [p.name for p in tmp_path.iterdir()] == ["heavy.pdf"]  # temporary text file removed


def test_a_missing_extractor_is_reported_not_raised(tmp_path):
    pdf = tmp_path / "s.pdf"
    pdf.write_bytes(sp.build_pdf([sp.blank_page()]))
    with pytest.raises(statements.ExtractionFailed) as exc:
        statements.extract_pdf_pages(str(tmp_path / "no-such-pdftotext.exe"), pdf, tmp_path)
    assert exc.value.code == "pdf_extractor_unavailable"


@needs_pdf
def test_extraction_slots_are_released_after_failures(tmp_path):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"%PDF-1.4\nnot a real pdf\n%%EOF\n")
    for _ in range(statements.MAX_CONCURRENT_PDF_EXTRACTIONS + 2):
        with pytest.raises(statements.ExtractionFailed):
            statements.extract_pdf_pages(PDFTOTEXT, bad, tmp_path)
    taken = [statements._extraction_slots.acquire(blocking=False) for _ in range(statements.MAX_CONCURRENT_PDF_EXTRACTIONS)]
    try:
        assert all(taken)
    finally:
        for ok in taken:
            if ok:
                statements._extraction_slots.release()


@pytest.fixture
def busy_slots(monkeypatch):
    """Every extraction slot held, as if other uploads were being read."""
    monkeypatch.setattr(statements, "EXTRACTION_WAIT_SECONDS", 0.1)
    held = [statements._extraction_slots.acquire(blocking=False) for _ in range(statements.MAX_CONCURRENT_PDF_EXTRACTIONS)]
    assert all(held)
    yield
    for _ in held:
        statements._extraction_slots.release()


def test_extraction_waits_only_briefly_for_a_slot(tmp_path, busy_slots):
    pdf = tmp_path / "s.pdf"
    pdf.write_bytes(sp.build_pdf([sp.blank_page()]))
    with pytest.raises(statements.ExtractorBusy):
        statements.extract_pdf_pages(PDFTOTEXT or "pdftotext", pdf, tmp_path)
    assert [p.name for p in tmp_path.iterdir()] == ["s.pdf"]


@pytest.fixture
def ready_client(tmp_path):
    db_path = tmp_path / "var" / "app.db"
    app = create_app(Settings(environment="development", database_path=db_path,
                              pdftotext_path=PDFTOTEXT or str(tmp_path / "none.exe")))
    ca, code = ca_with_code(app, db_path)
    client = new_client(app)
    sign_in(client, app, code["code"])
    reference = open_case(client).json()["case"]["reference"]
    client.post(f"/api/client/cases/{reference}/profile",
                json={"full_name": "Asha Synthetic", "bank_name": "Synthetic Bank Ltd"}, headers=H)
    yield client, reference, db_path, tmp_path / "var" / "storage"
    client.close(), ca.close()


@needs_pdf
def test_a_busy_server_refuses_the_upload_without_storing_it(ready_client, busy_slots):
    client, reference, db_path, storage = ready_client
    data = sp.build_pdf([sp.statement_page([("01/04/2025", "SYNTHETIC", "1.00", "", "9.00")], opening="10.00")])
    response = client.post(f"/api/client/cases/{reference}/statements", content=data,
                           headers={**H, "Content-Type": "application/pdf", "X-Upload-Filename": quote("s.pdf")})
    assert response.status_code == 503 and response.json()["error"] == "busy"
    assert response.headers["retry-after"] == "30"
    assert db_rows(db_path, "SELECT count(*) FROM statement_uploads")[0][0] == 0
    assert db_rows(db_path, "SELECT count(*) FROM documents")[0][0] == 0
    assert [p for p in storage.rglob("*") if p.is_file()] == []


@needs_pdf
def test_after_a_busy_refusal_the_same_upload_succeeds(ready_client, monkeypatch):
    client, reference, db_path, _ = ready_client
    data = sp.build_pdf([sp.statement_page([("01/04/2025", "SYNTHETIC", "1.00", "", "9.00")], opening="10.00")])
    headers = {**H, "Content-Type": "application/pdf", "X-Upload-Filename": quote("s.pdf")}
    monkeypatch.setattr(statements, "EXTRACTION_WAIT_SECONDS", 0.1)
    held = [statements._extraction_slots.acquire(blocking=False) for _ in range(statements.MAX_CONCURRENT_PDF_EXTRACTIONS)]
    try:
        assert client.post(f"/api/client/cases/{reference}/statements", content=data, headers=headers).status_code == 503
    finally:
        for _ in held:
            statements._extraction_slots.release()
    retry = client.post(f"/api/client/cases/{reference}/statements", content=data, headers=headers)
    assert retry.status_code == 201 and retry.json()["statement"]["status"] == "extracted"


def test_a_csv_upload_never_waits_for_pdf_slots(ready_client, busy_slots):
    client, reference, _, _ = ready_client
    csv = b"Date,Narration,Debit,Credit,Balance\n01/04/2025,SYNTHETIC,1.00,,9.00\n"
    response = client.post(f"/api/client/cases/{reference}/statements", content=csv,
                           headers={**H, "Content-Type": "text/csv", "X-Upload-Filename": quote("s.csv")})
    assert response.status_code == 201


# === resend-verification limit ==================================================================================

def test_resend_verification_is_limited_per_address_with_an_unchanged_answer(tmp_path):
    db_path = tmp_path / "var" / "app.db"
    app = create_app(Settings(environment="development", database_path=db_path))
    with new_client(app) as client:
        register(client)
        answers = {client.post("/api/ca/resend-verification", json={"email": "ca-a@example.test"}, headers=H).text
                   for _ in range(app_module.RESEND_VERIFICATION_PER_EMAIL + 3)}
        assert len(answers) == 1
        sent = [m for m in messages(app) if m.to == "ca-a@example.test"]
        # 1 from registration + the allowed resends; extra requests send nothing.
        assert len(db_rows(db_path, "SELECT id FROM email_outbox WHERE template = 'ca_verify_email'")) == \
            1 + app_module.RESEND_VERIFICATION_PER_EMAIL
        assert sent  # the newest link is still delivered
        other = client.post("/api/ca/resend-verification", json={"email": "someone-else@example.test"}, headers=H)
        assert other.status_code == 202  # other addresses are unaffected
