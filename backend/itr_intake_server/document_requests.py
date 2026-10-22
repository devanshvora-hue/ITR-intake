"""CA document requests and client supporting-document uploads (Stage 5.9).

A CA asks for a document on one case; the owning client uploads PDF, JPEG or
PNG files to that request. Files are stored with the existing private
storage (`statements.Storage`: random names under `<firm>/<case>/`, link and
path checks) as `documents` rows of kind 'supporting' linked to the request.

Upload checks: extension, declared content type and the file's actual
signature must agree; empty, oversized, truncated and malformed files are
refused and never stored. Storing the document, marking the request
'received' and the audit event happen in one transaction; on any failure the
file is removed. Nothing here logs file contents, names or storage paths.
"""

import hashlib
import logging
import re
import secrets
from dataclasses import dataclass

from . import repository as repo
from .repository import FirmScope
from .statements import Storage, StorageError, sanitise_display_name

logger = logging.getLogger("itr_intake.documents")

MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
MAX_FILES_PER_REQUEST = 5
LABEL_MIN, LABEL_MAX, DESCRIPTION_MAX = 2, 120, 500

# extension in the filename -> stored extension, canonical content type, accepted declared types
_TYPES = {
    "pdf": ("pdf", "application/pdf", {"", "application/pdf", "application/x-pdf", "application/octet-stream"}),
    "jpg": ("jpg", "image/jpeg", {"", "image/jpeg", "image/jpg", "image/pjpeg", "application/octet-stream"}),
    "jpeg": ("jpg", "image/jpeg", {"", "image/jpeg", "image/jpg", "image/pjpeg", "application/octet-stream"}),
    "png": ("png", "image/png", {"", "image/png", "application/octet-stream"}),
}
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class RequestInvalid(Exception):
    def __init__(self, fields: list[str]) -> None:
        self.fields = fields
        super().__init__("invalid request")


class UploadRefused(Exception):
    """A refused upload. `code` is a fixed, safe string; nothing is stored."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


# --- requests ---------------------------------------------------------------------------------------------


def _clean(text: object, *, max_len: int) -> str | None:
    if text is None:
        return None
    if not isinstance(text, str):
        raise TypeError
    value = re.sub(r"\s+", " ", text).strip()
    if any(not ch.isprintable() for ch in value) or len(value) > max_len:
        raise ValueError
    return value or None


def create_request(conn, *, scope: FirmScope, case: dict, actor_id: str, label: object, description: object,
                   required: bool) -> dict:
    """Create a CA document request on a case of the caller's firm. The key is
    generated here (slug of the label plus a random suffix), never taken from
    the browser. Raises RequestInvalid (field names only) or UploadRefused('case_closed')."""
    if case["status"] == "closed":
        raise UploadRefused("case_closed")
    bad = []
    try:
        clean_label = _clean(label, max_len=LABEL_MAX)
        if clean_label is None or len(clean_label) < LABEL_MIN:
            bad.append("label")
    except (TypeError, ValueError):
        bad.append("label")
    try:
        clean_description = _clean(description, max_len=DESCRIPTION_MAX)
    except (TypeError, ValueError):
        bad.append("description")
    if bad:
        raise RequestInvalid(bad)
    slug = re.sub(r"[^a-z0-9]+", "_", clean_label.lower()).strip("_")[:40] or "document"
    key = f"{slug}_{secrets.token_hex(3)}"
    with repo._atomic(conn):
        request = repo.add_document_request(conn, scope, case["id"], key=key, label=clean_label, source="ca",
                                            description=clean_description, required=required)
        repo.record_audit_event(conn, actor_kind="ca", actor_id=actor_id, firm_id=scope.firm_id, case_id=case["id"],
                                action="document_request.created", details={"request_id": request["id"]})
    return request


def change_status(conn, *, scope: FirmScope, case: dict, request_id: object, actor_id: str, action: str) -> dict:
    """CA waive / reopen. waive: requested|received -> waived (files stay stored).
    reopen: waived -> received if the request already has files, else requested,
    so an outstanding request never holds uploads. Raises repo.NotFound,
    UploadRefused('case_closed') or UploadRefused('invalid_transition')."""
    with repo._atomic(conn):
        request = repo.get_document_request(conn, scope, case["id"], request_id)  # NotFound outside the case
        if case["status"] == "closed":
            raise UploadRefused("case_closed")
        if action == "waive":
            if request["status"] == "waived":
                raise UploadRefused("invalid_transition")
            target = "waived"
        else:
            if request["status"] != "waived":
                raise UploadRefused("invalid_transition")
            has_files = bool(repo.list_request_documents(conn, scope, case["id"], request["id"]))
            target = "received" if has_files else "requested"
        updated = repo.set_document_request_status(conn, scope, case["id"], request["id"], target)
        repo.record_audit_event(conn, actor_kind="ca", actor_id=actor_id, firm_id=scope.firm_id, case_id=case["id"],
                                action=f"document_request.{'waived' if action == 'waive' else 'reopened'}",
                                details={"request_id": request["id"], "from": request["status"], "to": target})
    return updated


def request_view(conn, scope: FirmScope, case_id: str, request: dict, *, for_ca: bool) -> dict:
    files = repo.list_request_documents(conn, scope, case_id, request["id"])
    return {
        "id": request["id"],
        "label": request["label"],
        "description": request["description"],
        "required": bool(request["required"]),
        "status": request["status"],
        "created_at": request["created_at"],
        "files": [{**({"id": f["id"]} if for_ca else {}), "display_name": f["display_name"],
                   "content_type": f["content_type"], "size_bytes": f["size_bytes"], "uploaded_at": f["created_at"]}
                  for f in files],
    }


def list_views(conn, scope: FirmScope, case_id: str, *, for_ca: bool) -> list[dict]:
    return [request_view(conn, scope, case_id, r, for_ca=for_ca)
            for r in repo.list_document_requests(conn, scope, case_id)]


# --- uploads ------------------------------------------------------------------------------------------------


def check_document(data: bytes, filename: object, content_type: object) -> tuple[str, str]:
    """(stored extension, canonical content type) for an acceptable file;
    UploadRefused with a fixed code otherwise."""
    m = re.search(r"\.([A-Za-z0-9]{1,8})\s*$", filename if isinstance(filename, str) else "")
    ext = m.group(1).lower() if m else ""
    if not data:
        raise UploadRefused("empty_file")
    if ext not in _TYPES:
        raise UploadRefused("unsupported_file_type")
    stored_ext, canonical, accepted = _TYPES[ext]
    declared = (content_type if isinstance(content_type, str) else "").split(";")[0].strip().lower()
    if declared not in accepted:
        raise UploadRefused("type_mismatch")
    if len(data) > MAX_DOCUMENT_BYTES:
        raise UploadRefused("file_too_large")
    if stored_ext == "pdf":
        if not data.startswith(b"%PDF-"):
            raise UploadRefused("type_mismatch")
        if b"%%EOF" not in data[-2048:]:
            raise UploadRefused("truncated_file")
    elif stored_ext == "jpg":
        if not data.startswith(b"\xff\xd8\xff"):
            raise UploadRefused("type_mismatch")
        if b"\xff\xd9" not in data[-1024:]:
            raise UploadRefused("truncated_file")
    else:
        if not data.startswith(_PNG_SIGNATURE):
            raise UploadRefused("type_mismatch")
        if b"IEND" not in data[-64:]:
            raise UploadRefused("truncated_file")
    return stored_ext, canonical


@dataclass(frozen=True)
class UploadOutcome:
    document: dict
    created: bool  # False when the same file was already stored for this request


def handle_upload(conn, *, scope: FirmScope, case: dict, request_id: object, actor_id: str, data: bytes,
                  filename: object, content_type: object, storage: Storage) -> UploadOutcome:
    """Store one supporting document for a request of a case the caller owns.
    Raises repo.NotFound (request outside the case) or UploadRefused."""
    request = repo.get_document_request(conn, scope, case["id"], request_id)  # NotFound outside the case
    if case["status"] == "closed":
        raise UploadRefused("case_closed")
    if request["status"] == "waived":
        raise UploadRefused("request_waived")
    stored_ext, canonical = check_document(data, filename, content_type)

    digest = hashlib.sha256(data).hexdigest()
    try:
        existing = repo.find_supporting_document_by_hash(conn, scope, case["id"], digest)
    except repo.NotFound:
        existing = None
    if existing is not None:
        if existing["request_id"] == request["id"]:
            return UploadOutcome(existing, False)
        raise UploadRefused("already_uploaded_for_another_request")
    if len(repo.list_request_documents(conn, scope, case["id"], request["id"])) >= MAX_FILES_PER_REQUEST:
        raise UploadRefused("file_limit_reached")

    staged = storage.stage(data, stored_ext)
    final = None
    try:
        with repo._atomic(conn):
            document = repo.add_document(conn, scope, case["id"], kind="supporting", extension=stored_ext,
                                         display_name=sanitise_display_name(filename), content_type=canonical,
                                         size_bytes=len(data), sha256=digest, uploaded_by="client",
                                         request_id=request["id"])
            if request["status"] == "requested":
                repo.set_document_request_status(conn, scope, case["id"], request["id"], "received")
            repo.record_audit_event(conn, actor_kind="client", actor_id=actor_id, firm_id=scope.firm_id,
                                    case_id=case["id"], action="document.uploaded",
                                    details={"request_id": request["id"], "document_id": document["id"]})
            final = storage.promote(staged, document["storage_key"])
            staged = None
    except repo.Conflict as exc:
        if final is not None:
            final.unlink(missing_ok=True)
        if exc.code != "duplicate_document":
            raise
        existing = repo.find_supporting_document_by_hash(conn, scope, case["id"], digest)  # concurrent duplicate
        if existing["request_id"] != request["id"]:
            raise UploadRefused("already_uploaded_for_another_request") from None
        return UploadOutcome(existing, False)
    except BaseException:
        if final is not None:
            final.unlink(missing_ok=True)
        raise
    finally:
        storage.remove_staged(staged)
    logger.info("supporting document stored document=%s request=%s", document["id"], request["id"])
    return UploadOutcome(document, True)


def document_view(document: dict) -> dict:
    return {"display_name": document["display_name"], "content_type": document["content_type"],
            "size_bytes": document["size_bytes"], "uploaded_at": document["created_at"]}


def load_supporting_file(conn, *, scope: FirmScope, case: dict, document_id: object, actor_id: str,
                         storage: Storage) -> tuple[dict, bytes]:
    """A stored supporting document of the CA's own case, with its bytes.
    Raises repo.NotFound for anything else (other case or firm, bank statements,
    workbooks, unknown IDs) and for a missing or unreadable file."""
    document = repo.get_document(conn, scope, case["id"], document_id)
    if document["kind"] != "supporting" or document["request_id"] is None or document["status"] != "stored":
        raise repo.NotFound()
    try:
        data = storage.path_for(document["storage_key"]).read_bytes()
    except (OSError, StorageError):
        logger.error("supporting document unreadable document=%s", document["id"])
        raise repo.NotFound() from None
    repo.record_audit_event(conn, actor_kind="ca", actor_id=actor_id, firm_id=scope.firm_id, case_id=case["id"],
                            action="document.downloaded", details={"document_id": document["id"]})
    return document, data
