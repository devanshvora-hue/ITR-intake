"""Bank-statement uploads (Stage 5.7): file checks, private storage, local
PDF text extraction, processing and the recorded outcome.

Flow for one upload (all inside the request; nothing leaves this machine)
---------------------------------------------------------------------------
1. Size, filename extension, browser content type and the file's actual
   signature are checked. Anything wrong: an upload record with status
   'rejected' and a reason code; the bytes are discarded, never stored.
2. A repeat of a file already stored for the case (same SHA-256) returns the
   existing upload instead of a second copy.
3. The bytes are written to a private staging file with a random name
   (`<storage_root>/.staging/`, owner-only permissions where supported).
4. CSV: parsed in memory. PDF: xpdf `pdftotext -simple` runs on the staging
   file without a shell, with a page cap, a timeout and an output-size cap;
   its page text is parsed. Results come from `itr_intake.statement_import`.
5. A file-level failure (unreadable, password-protected, copy-restricted,
   too many pages, unusable CSV) is 'rejected' and its staging file deleted.
   Otherwise the `documents` row is created, the file moves to its final key
   "<firm_id>/<case_id>/<document_id>.<ext>", and the upload record is saved
   with the outcome, in one transaction. If anything fails, the file is
   removed and nothing is recorded as stored.

Only counts, reason codes, row numbers and page numbers are stored and
logged; never file contents, transactions, account details or local paths.
There is no download route.
"""

import hashlib
import logging
import os
import re
import secrets
import shutil
import stat
import subprocess
import threading
import time
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from itr_intake import statement_import as si

from . import repository as repo
from .repository import FirmScope

logger = logging.getLogger("itr_intake.statements")

MAX_PDF_BYTES = 10 * 1024 * 1024
MAX_CSV_BYTES = 2 * 1024 * 1024
MAX_UPLOAD_BYTES = MAX_PDF_BYTES
MAX_STORED_STATEMENTS_PER_CASE = 5
MAX_PDF_PAGES = 100
PDF_TIMEOUT_SECONDS = 30
MAX_PDF_TEXT_BYTES = 8 * 1024 * 1024
STAGING_MAX_AGE = timedelta(hours=1)

_CONTENT_TYPES = {
    "pdf": {"", "application/pdf", "application/x-pdf", "application/octet-stream"},
    "csv": {"", "text/csv", "application/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream",
            "text/comma-separated-values"},
}
_BINARY_MAGIC = (b"%PDF", b"PK\x03\x04", b"\x89PNG", b"\xff\xd8\xff", b"GIF8", b"\xd0\xcf\x11\xe0", b"Rar!",
                 b"7z\xbc\xaf", b"\x1f\x8b", b"MZ", b"BM", b"II*\x00", b"MM\x00*")
_KEY = re.compile(r"^([0-9a-f-]{36})/([0-9a-f-]{36})/([0-9a-f-]{36})\.(pdf|csv|jpg|png)$")


class StorageError(Exception):
    """A storage path or file operation was refused. Message is safe."""


class UploadRefused(Exception):
    """The request cannot be accepted at all (e.g. the per-case limit)."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


# --- names and file checks --------------------------------------------------------------------------------


def sanitise_display_name(name: object) -> str:
    """A display-only name: the last path component, printable ASCII-ish
    characters only, at most 100 characters. Never used as a path."""
    text = name if isinstance(name, str) else ""
    text = re.split(r"[\\/]", text)[-1]
    text = unicodedata.normalize("NFKC", text)
    text = "".join(ch if (ch.isalnum() or ch in " ._()-") and ch.isprintable() else "_" for ch in text).strip(" .")
    text = re.sub(r"_+", "_", text)[:100].strip()
    return text or "statement"


def _extension(name: object) -> str:
    text = name if isinstance(name, str) else ""
    m = re.search(r"\.([A-Za-z0-9]{1,8})\s*$", text)
    return m.group(1).lower() if m else ""


def detect_type(data: bytes) -> str | None:
    if data.startswith(b"%PDF-"):
        return "pdf"
    if data.startswith(_BINARY_MAGIC) or b"\x00" in data[:4096]:
        return None
    # Text without NUL bytes: treated as CSV here; the CSV parser then refuses
    # anything that is not UTF-8 with its own, more specific reason.
    return "csv"


def check_upload(data: bytes, filename: object, content_type: object) -> tuple[str, str | None]:
    """(file_type, error_code). error_code None means the file may be processed."""
    ext = _extension(filename)
    claimed = ext if ext in ("pdf", "csv") else "unknown"
    if not data:
        return claimed, "empty_file"
    if ext not in ("pdf", "csv"):
        return claimed, "unsupported_file_type"
    detected = detect_type(data)
    if detected is None:
        return claimed, "unsupported_content"
    if detected != ext:
        return claimed, "type_mismatch"
    ctype = (content_type if isinstance(content_type, str) else "").split(";")[0].strip().lower()
    if ctype not in _CONTENT_TYPES[ext]:
        return claimed, "type_mismatch"
    if len(data) > (MAX_PDF_BYTES if ext == "pdf" else MAX_CSV_BYTES):
        return claimed, "file_too_large"
    if ext == "pdf" and b"%%EOF" not in data[-2048:]:
        return claimed, "truncated_pdf"
    return ext, None


# --- private storage ------------------------------------------------------------------------------------------


class Storage:
    """Files under one private root. Keys come only from the repository
    ("<firm>/<case>/<document>.<ext>"); every path is resolved and checked to
    stay inside the root, and symlinks are refused."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    @staticmethod
    def _is_link(path: Path) -> bool:
        # Windows directory junctions are not symlinks to `is_symlink()` and
        # need no special privilege to create, so both are refused.
        return path.is_symlink() or path.is_junction()

    def _root(self) -> Path:
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self._is_link(self.root):
            raise StorageError("storage root must not be a link")
        return self.root.resolve()

    def _safe_dir(self, *parts: str) -> Path:
        """An existing or new directory below the root. Every component is
        checked before anything is created inside it, so nothing is ever
        created through a link."""
        root = self._root()
        current = root
        for part in parts:
            current = current / part
            if self._is_link(current):
                raise StorageError("links are not allowed in storage")
            if current.exists() and not current.is_dir():
                raise StorageError("storage path is not a directory")
            if not current.exists():
                current.mkdir(mode=0o700)
            if not current.resolve().is_relative_to(root):
                raise StorageError("path escapes the storage root")
        return current.resolve()

    def path_for(self, key: str) -> Path:
        m = _KEY.match(key or "")
        if not m:
            raise StorageError("invalid storage key")
        directory = self._safe_dir(m.group(1), m.group(2))
        target = directory / f"{m.group(3)}.{m.group(4)}"
        if self._is_link(target) or not target.resolve().is_relative_to(self._root()):
            raise StorageError("invalid storage path")
        return target

    def stage(self, data: bytes, extension: str) -> Path:
        """Write bytes to a new private staging file with a random name."""
        if extension not in ("pdf", "csv", "jpg", "png"):
            raise StorageError("invalid extension")
        directory = self._safe_dir(".staging")
        target = directory / f"{secrets.token_hex(16)}.{extension}"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(target, flags, 0o600)
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        return target

    def promote(self, staged: Path, key: str) -> Path:
        """Move a staged file to its final key (never overwriting)."""
        if staged.parent.resolve() != self._safe_dir(".staging"):
            raise StorageError("not a staging file")
        final = self.path_for(key)
        if final.exists():
            raise StorageError("storage key already in use")
        os.replace(staged, final)
        try:
            os.chmod(final, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass
        return final

    def staging_dir(self) -> Path:
        """The private staging folder (link-checked), for short-lived work files."""
        return self._safe_dir(".staging")

    def remove_staged(self, staged: Path | None) -> None:
        if staged is not None and staged.parent.resolve() == self._safe_dir(".staging"):
            staged.unlink(missing_ok=True)

    def remove(self, key: str) -> None:
        self.path_for(key).unlink(missing_ok=True)

    def clean_staging(self, *, older_than: timedelta = STAGING_MAX_AGE) -> int:
        """Delete abandoned staging files (only inside the staging folder)."""
        directory = self._safe_dir(".staging")
        cutoff = datetime.now(UTC).timestamp() - older_than.total_seconds()
        removed = 0
        for entry in directory.iterdir():
            if entry.is_file() and not entry.is_symlink() and entry.stat().st_mtime < cutoff:
                entry.unlink(missing_ok=True)
                removed += 1
        return removed


# --- PDF text extraction --------------------------------------------------------------------------------------


class ExtractionFailed(Exception):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def find_pdftotext(configured: str | None = None) -> str | None:
    """The xpdf `pdftotext` binary (ITR_PDFTOTEXT, or on PATH), only if it is
    xpdf (the `-simple` mode used here does not exist in Poppler)."""
    candidate = configured or os.environ.get("ITR_PDFTOTEXT") or shutil.which("pdftotext")
    if not candidate:
        return None
    try:
        probe = subprocess.run([candidate, "-v"], capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    banner = (probe.stdout + probe.stderr).decode("latin-1", "replace").lower()
    return candidate if "xpdf" in banner else None


class ExtractorBusy(Exception):
    """All PDF extraction slots stayed busy for EXTRACTION_WAIT_SECONDS."""


# PDF extraction is CPU-heavy (a small crafted PDF can keep pdftotext busy
# until the timeout), so only a few run at once in this process; other uploads
# wait briefly and are then told to retry instead of piling up.
MAX_CONCURRENT_PDF_EXTRACTIONS = 2
EXTRACTION_WAIT_SECONDS = 10
_extraction_slots = threading.BoundedSemaphore(MAX_CONCURRENT_PDF_EXTRACTIONS)
_POLL_SECONDS = 0.2


def _run_pdftotext(args: list[str], out: Path) -> int:
    """Run pdftotext, killing it on timeout or as soon as its output file
    grows past MAX_PDF_TEXT_BYTES. Returns its exit code."""
    try:
        proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        raise ExtractionFailed("pdf_extractor_unavailable") from None
    deadline = time.monotonic() + PDF_TIMEOUT_SECONDS
    try:
        while True:
            try:
                return proc.wait(timeout=_POLL_SECONDS)
            except subprocess.TimeoutExpired:
                pass
            try:
                size = out.stat().st_size
            except OSError:
                size = 0
            if size > MAX_PDF_TEXT_BYTES:
                raise ExtractionFailed("pdf_text_too_large")
            if time.monotonic() >= deadline:
                raise ExtractionFailed("pdf_timeout")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def extract_pdf_pages(pdftotext: str, pdf_path: Path, work_dir: Path) -> list[str]:
    """Page texts from xpdf `pdftotext -simple`. Raises ExtractionFailed, or
    ExtractorBusy when no extraction slot frees up in time."""
    if not _extraction_slots.acquire(timeout=EXTRACTION_WAIT_SECONDS):
        raise ExtractorBusy()
    out = work_dir / f"{secrets.token_hex(16)}.txt"
    try:
        code = _run_pdftotext([pdftotext, "-simple", "-enc", "UTF-8", "-eol", "unix", "-q", "-l",
                               str(MAX_PDF_PAGES + 1), str(pdf_path), str(out)], out)
        if code == 3:
            raise ExtractionFailed("pdf_copy_restricted")
        if code != 0 or not out.exists():
            raise ExtractionFailed("pdf_unreadable")
        if out.stat().st_size > MAX_PDF_TEXT_BYTES:
            raise ExtractionFailed("pdf_text_too_large")
        text = out.read_bytes().decode("utf-8", "replace")
    finally:
        out.unlink(missing_ok=True)
        _extraction_slots.release()
    pages = text.split("\f")
    if pages and not pages[-1].strip():
        pages = pages[:-1]
    if len(pages) > MAX_PDF_PAGES:
        raise ExtractionFailed("too_many_pages")
    return pages


def _contains_images(data: bytes) -> bool:
    # Image XObjects are streams, which cannot live inside object streams, so
    # their dictionaries are visible in the raw file.
    return re.search(rb"/Subtype\s*/Image", data) is not None


# --- processing ------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class UploadOutcome:
    upload: dict
    created: bool  # False when an identical file was already stored for the case


def _process(data: bytes, file_type: str, staged: Path, *, financial_year: str, pdftotext: str | None,
             storage: Storage) -> si.ImportResult:
    if file_type == "csv":
        return si.parse_csv(data, financial_year=financial_year)
    if pdftotext is None:
        return si.ImportResult("pdf", si.MANUAL_REVIEW, review_reasons=("pdf_extractor_unavailable",))
    try:
        pages = extract_pdf_pages(pdftotext, staged, staged.parent)
    except ExtractionFailed as exc:
        code = exc.code
        if code == "pdf_unreadable" and b"/Encrypt" in data:
            code = "pdf_password_protected"
        if code == "pdf_extractor_unavailable":
            return si.ImportResult("pdf", si.MANUAL_REVIEW, review_reasons=(code,))
        return si.ImportResult("pdf", si.REJECTED, error_code=code)
    return si.parse_pdf_pages(pages, financial_year=financial_year, contains_images=_contains_images(data))


def _result_fields(result: si.ImportResult) -> dict:
    return {
        "reasons": list(result.review_reasons),
        "page_warnings": [{"page": w.page, "code": w.code} for w in result.page_warnings],
        "rejected_rows": [{"row": r.row_number, "codes": list(r.codes), **({"page": r.page} if r.page else {})}
                          for r in result.rejected],
        "duplicate_rows": list(result.duplicate_rows),
        "pages_total": result.pages_total,
        "rows_extracted": len(result.transactions),
        "rows_rejected": len(result.rejected),
        "rows_duplicate": len(result.duplicate_rows),
        "rows_summary": result.summary_rows,
        "period_start": result.period_start.isoformat() if result.period_start else None,
        "period_end": result.period_end.isoformat() if result.period_end else None,
    }


def handle_upload(conn, *, scope: FirmScope, case: dict, actor_id: str, data: bytes, filename: object,
                  content_type: object, storage: Storage, pdftotext: str | None) -> UploadOutcome:
    """Validate, process and record one upload for a case the caller has
    already been authorised for. Raises UploadRefused("upload_limit_reached")
    for the per-case limit, or UploadRefused("busy") when every PDF extraction
    slot stayed busy (nothing is stored or recorded then)."""
    case_id = case["id"]
    display_name = sanitise_display_name(filename)
    file_type, error = check_upload(data, filename, content_type)
    if error:
        upload = repo.create_statement_upload(conn, scope, case_id, file_type=file_type, display_name=display_name,
                                              size_bytes=len(data), status=si.REJECTED, error_code=error)
        logger.info("statement rejected upload=%s type=%s code=%s", upload["id"], file_type, error)
        return UploadOutcome(upload, True)

    digest = hashlib.sha256(data).hexdigest()
    try:
        existing = repo.find_bank_statement_by_hash(conn, scope, case_id, digest)
        return UploadOutcome(repo.get_statement_upload_for_document(conn, scope, case_id, existing["id"]), False)
    except repo.NotFound:
        pass
    if repo.count_stored_statements(conn, scope, case_id) >= MAX_STORED_STATEMENTS_PER_CASE:
        raise UploadRefused("upload_limit_reached")

    staged = storage.stage(data, file_type)
    try:
        try:
            result = _process(data, file_type, staged, financial_year=case["financial_year"], pdftotext=pdftotext,
                              storage=storage)
            status = result.status
        except ExtractorBusy:
            # Nothing is recorded; the staging file is removed below and the client may retry.
            raise UploadRefused("busy") from None
        except Exception as exc:  # unexpected parser failure: keep the file, record a safe code
            logger.error("statement processing failed type=%s error=%s", file_type, type(exc).__name__)
            result, status = si.ImportResult(file_type, "processing_failed", error_code="unexpected_error"), \
                "processing_failed"

        if status == si.REJECTED:
            storage.remove_staged(staged)
            staged = None
            upload = repo.create_statement_upload(conn, scope, case_id, file_type=file_type,
                                                  display_name=display_name, size_bytes=len(data), status=status,
                                                  error_code=result.error_code)
            logger.info("statement rejected upload=%s type=%s code=%s", upload["id"], file_type, result.error_code)
            return UploadOutcome(upload, True)

        final: Path | None = None
        try:
            with repo._atomic(conn):
                document = repo.add_document(conn, scope, case_id, kind="bank_statement", extension=file_type,
                                             display_name=display_name,
                                             content_type="application/pdf" if file_type == "pdf" else "text/csv",
                                             size_bytes=len(data), sha256=digest, uploaded_by="client")
                upload = repo.create_statement_upload(conn, scope, case_id, file_type=file_type,
                                                      display_name=display_name, size_bytes=len(data), status=status,
                                                      document_id=document["id"], error_code=result.error_code,
                                                      **_result_fields(result))
                if case["status"] == "draft":
                    current = repo.get_case(conn, scope, case_id)
                    if current["status"] == "draft":
                        repo.update_case(conn, scope, case_id, expected_version=current["version"],
                                         status="statement_uploaded")
                repo.record_audit_event(conn, actor_kind="client", actor_id=actor_id, firm_id=scope.firm_id,
                                        case_id=case_id, action="statement.uploaded",
                                        details={"upload_id": upload["id"], "status": status})
                final = storage.promote(staged, document["storage_key"])
                staged = None
        except repo.Conflict as exc:
            if final is not None:
                final.unlink(missing_ok=True)
            if exc.code != "duplicate_document":
                raise
            existing = repo.find_bank_statement_by_hash(conn, scope, case_id, digest)  # a concurrent identical upload
            return UploadOutcome(repo.get_statement_upload_for_document(conn, scope, case_id, existing["id"]), False)
        except BaseException:
            if final is not None:
                final.unlink(missing_ok=True)
            raise
        logger.info("statement stored upload=%s type=%s status=%s extracted=%d rejected=%d", upload["id"], file_type,
                    status, upload["rows_extracted"], upload["rows_rejected"])
        return UploadOutcome(upload, True)
    finally:
        storage.remove_staged(staged)


def upload_view(upload: dict) -> dict:
    """What a client or the owning firm's CA may see about an upload."""
    return {
        "id": upload["id"],
        "file_type": upload["file_type"],
        "display_name": upload["display_name"],
        "size_bytes": upload["size_bytes"],
        "status": upload["status"],
        "error_code": upload["error_code"],
        "reasons": upload["reasons_json"],
        "page_warnings": upload["page_warnings_json"],
        "rejected_rows": upload["rejected_rows_json"],
        "duplicate_rows": upload["duplicate_rows_json"],
        "pages_total": upload["pages_total"],
        "rows_extracted": upload["rows_extracted"],
        "rows_rejected": upload["rows_rejected"],
        "rows_duplicate": upload["rows_duplicate"],
        "rows_summary": upload["rows_summary"],
        "period_start": upload["period_start"],
        "period_end": upload["period_end"],
        "uploaded_at": upload["created_at"],
    }
