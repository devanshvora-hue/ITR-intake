"""Stage 5.2: IDs and repository layer. Temporary databases only; all data synthetic.
Two firms, each with a case, so every cross-firm check is meaningful."""

import sqlite3
from decimal import Decimal

import pytest

import itr_intake_server.repository as repo
from itr_intake_server.db import DEFAULT_DATABASE_PATH, initialize_database, utc_now
from itr_intake_server.ids import (
    InvalidId,
    generate_id,
    money_text,
    new_case_reference,
    normalise_email,
    parse_id,
    reference_name,
    validate_financial_year,
)
from itr_intake_server.repository import Conflict, FirmScope, InvalidInput, NotFound, NotPermitted

HASH = "a" * 64
LATER = "2999-01-01T00:00:00.000000Z"


@pytest.fixture
def db(tmp_path):
    conn = initialize_database(tmp_path / "repo.db")
    yield conn
    conn.close()


def make_firm(db, tag):
    firm = repo.create_firm(db, name=f"Firm {tag} (synthetic)", registration_number=f"FRN-{tag}-SYN")
    repo.admin_set_firm_status(db, firm["id"], "active", approved_by="operator")
    scope = FirmScope(firm["id"])
    user = repo.create_ca_user(db, firm_id=firm["id"], email=f"ca-{tag}@example.test", full_name=f"CA {tag}",
                               password_hash="scrypt$synthetic")
    code = repo.create_firm_code(db, scope, f"CODE{tag}2025")
    client = repo.get_or_create_client_identity(db, scope, f"client-{tag}@example.test")
    case = repo.create_case(db, scope, client_identity_id=client["id"], first_name="Demo",
                            financial_year="2025-26", firm_code_id=code["id"])
    return {"firm": firm, "scope": scope, "user": user, "code": code, "client": client, "case": case}


@pytest.fixture
def world(db):
    return {"a": make_firm(db, "A"), "b": make_firm(db, "B")}


def row(n, **over):
    base = {"row_number": n, "is_valid": True, "raw_date": "01/04/2025", "raw_narration": "SYNTHETIC CREDIT",
            "raw_credit": "100.00", "txn_date": "2025-04-01", "narration": "SYNTHETIC CREDIT", "debit": Decimal("0"),
            "credit": Decimal("100.00"), "balance": Decimal("100.00"), "category": "Others – Needs Review",
            "review_status": "Needs review", "matched_rule": "uncertain", "flags": [], "issues": []}
    base.update(over)
    return base


def add_q(db, w, qid="Q-000000000001", **over):
    args = dict(question_id=qid, question="What was transaction T0001 for?", purpose="Clarify.",
                finding_ids=["F0001"], transaction_ids=["T0001"])
    args.update(over)
    return repo.add_question(db, w["scope"], w["case"]["id"], **args)


def add_doc(db, w, case_id=None, **over):
    args = dict(kind="bank_statement", extension="pdf", display_name="statement.pdf",
                content_type="application/pdf", size_bytes=1234, sha256=HASH, uploaded_by="client")
    args.update(over)
    return repo.add_document(db, w["scope"], case_id or w["case"]["id"], **args)


# === IDs ==========================================================================================

def test_parse_id_accepts_only_canonical_uuid4():
    good = generate_id()
    assert parse_id(good) == good
    for bad in (None, 123, "", "not-a-uuid", good.upper(), good.replace("-", ""), "00000000-0000-1000-8000-000000000000",
                f"{good} ", "' OR 1=1 --"):
        with pytest.raises(InvalidId):
            parse_id(bad)


def test_case_references_are_readable_and_random():
    ref = new_case_reference("Dévansh")
    assert ref.startswith("IT-DEVANSH-") and len(ref.split("-")[2]) == 6
    assert not set(ref.split("-")[2]) & set("ILOU")
    assert reference_name("  ") == "CLIENT" and reference_name("Ánna-Marie O'Neil") == "ANNAMARIEONE"
    assert len({new_case_reference("Asha") for _ in range(200)}) == 200


def test_input_normalisation():
    assert normalise_email("  Client@Example.TEST ") == "client@example.test"
    for bad in ("no-at-sign", "a@b", "two@@example.test", "spa ce@example.test", 5):
        with pytest.raises(ValueError):
            normalise_email(bad)
    assert validate_financial_year("2025-26") == "2025-26" and validate_financial_year("2099-00") == "2099-00"
    for bad in ("2025-27", "2025/26", "25-26"):
        with pytest.raises(ValueError):
            validate_financial_year(bad)
    assert money_text(Decimal("1250.50")) == "1250.50" and money_text("-5", allow_negative=True) == "-5"
    for bad in (1.5, "1e5x", "NaN", "-5", True):
        with pytest.raises(ValueError):
            money_text(bad)


# === creation and retrieval ============================================================================

def test_core_records_round_trip(db, world):
    a = world["a"]
    s, cid = a["scope"], a["case"]["id"]
    assert repo.get_firm(db, s)["status"] == "active"
    assert repo.get_ca_user(db, s, a["user"]["id"])["email_norm"] == "ca-a@example.test"
    assert repo.get_ca_user_for_login(db, "CA-A@example.test")["id"] == a["user"]["id"]
    assert repo.get_active_firm_code(db, s)["code"] == "CODEA2025"
    assert repo.find_active_firm_by_code(db, "code-a2025")["firm_id"] == a["firm"]["id"]
    assert repo.get_or_create_client_identity(db, s, "Client-A@example.test")["id"] == a["client"]["id"]
    case = repo.get_case(db, s, cid)
    assert case["reference"].startswith("IT-DEMO-") and case["status"] == "draft" and case["version"] == 1
    assert case["profile_json"] == {}
    assert repo.find_open_case(db, s, a["client"]["id"], "2025-26")["id"] == cid

    assert repo.replace_statement_rows(db, s, cid, [row(1), row(2, credit="2500.75", balance="-10.00")]) == 2
    rows = repo.list_statement_rows(db, s, cid)
    assert [(r["row_number"], r["credit"], r["balance"]) for r in rows] == [(1, "100.00", "100.00"), (2, "2500.75", "-10.00")]
    assert rows[0]["flags_json"] == [] and rows[0]["issues_json"] == []

    q = add_q(db, a)
    assert q["seq"] == 1 and q["status"] == "pending" and q["finding_ids_json"] == ["F0001"]
    assert repo.get_pending_question(db, s, cid)["question_id"] == "Q-000000000001"
    assert repo.answer_question(db, s, cid, "Q-000000000001", "A loan.")["status"] == "answered"
    assert add_q(db, a, "Q-000000000002")["seq"] == 2
    assert repo.withdraw_question(db, s, cid, "Q-000000000002")["status"] == "withdrawn"
    assert [x["seq"] for x in repo.list_questions(db, s, cid)] == [1, 2]

    c1 = repo.add_confirmation(db, s, cid, finding_id="F0008", proposed_category="Family Transfer", response="denied")
    c2 = repo.add_confirmation(db, s, cid, finding_id="F0008", proposed_category="Family Transfer", response="confirmed")
    assert (c1["seq"], c2["seq"]) == (1, 2) and len(repo.list_confirmations(db, s, cid)) == 2

    req = repo.add_document_request(db, s, cid, key="form_16", label="Form 16")
    assert repo.set_document_request_status(db, s, cid, req["id"], "received")["status"] == "received"
    doc = add_doc(db, a, kind="supporting", request_id=req["id"])
    assert doc["storage_key"] == f"{a['firm']['id']}/{cid}/{doc['id']}.pdf"
    assert repo.get_document(db, s, cid, doc["id"])["request_id"] == req["id"]
    assert [d["id"] for d in repo.list_documents(db, s, cid, kind="supporting")] == [doc["id"]]
    assert repo.set_document_status(db, s, cid, doc["id"], "superseded")["status"] == "superseded"

    sess = repo.create_session(db, kind="ca", firm_id=a["firm"]["id"], ca_user_id=a["user"]["id"], token_hash=HASH,
                               idle_expires_at=LATER, absolute_expires_at=LATER)
    assert repo.get_session_by_token_hash(db, HASH)["id"] == sess["id"]
    repo.touch_session(db, sess["id"], idle_expires_at=LATER)
    assert repo.revoke_ca_user_sessions(db, s, a["user"]["id"]) == 1
    with pytest.raises(NotFound):
        repo.get_session_by_token_hash(db, HASH)

    ch = repo.create_challenge(db, purpose="client_login", subject="client-a@example.test", secret_hash=HASH,
                               max_attempts=2, expires_at=LATER, firm_id=a["firm"]["id"])
    assert repo.record_challenge_attempt(db, ch["id"]) == 1 and repo.record_challenge_attempt(db, ch["id"]) == 2
    with pytest.raises(Conflict, match="no_attempts_left"):
        repo.record_challenge_attempt(db, ch["id"])
    assert repo.consume_challenge(db, ch["id"]) is True and repo.consume_challenge(db, ch["id"]) is False

    assert repo.increment_rate_limit(db, "otp:email:" + HASH, "2025-04-01T00:00:00Z") == 1
    assert repo.increment_rate_limit(db, "otp:email:" + HASH, "2025-04-01T00:00:00Z") == 2

    mail, created = repo.enqueue_email(db, idempotency_key=f"case:{cid}:ca_intake", template="ca_intake",
                                       recipient="ca-a@example.test", subject="New intake", body_text="Body",
                                       firm_id=a["firm"]["id"], case_id=cid)
    again, created_again = repo.enqueue_email(db, idempotency_key=f"case:{cid}:ca_intake", template="ca_intake",
                                              recipient="ca-a@example.test", subject="New intake", body_text="Body",
                                              firm_id=a["firm"]["id"], case_id=cid)
    assert created and not created_again and again["id"] == mail["id"]
    assert [m["id"] for m in repo.list_due_emails(db, LATER)] == [mail["id"]]
    failed = repo.mark_email_failed(db, mail["id"], error_code="smtp_timeout", next_attempt_at=LATER)
    assert failed["status"] == "failed" and failed["attempts"] == 1
    done = repo.mark_email_delivered(db, mail["id"], simulated=True, clear_body=True)
    assert done["status"] == "simulated" and done["body_text"] is None and done["sent_at"]
    other, _ = repo.enqueue_email(db, idempotency_key="k-2", template="t", recipient="x@example.test", subject="s",
                                  body_text=None, firm_id=a["firm"]["id"])
    assert repo.supersede_email(db, "k-2") is True and repo.supersede_email(db, "k-2") is False
    dead = repo.enqueue_email(db, idempotency_key="k-3", template="t", recipient="x@example.test", subject="s",
                              body_text=None)[0]
    assert repo.mark_email_failed(db, dead["id"], error_code="rejected", next_attempt_at=None)["status"] == "dead"

    ev = repo.record_audit_event(db, actor_kind="ca", actor_id=a["user"]["id"], action="case.viewed",
                                 firm_id=a["firm"]["id"], case_id=cid, details={"via": "dashboard"})
    assert ev["details_json"] == {"via": "dashboard"}
    assert [e["id"] for e in repo.list_audit_events(db, s, case_id=cid)] == [ev["id"]]


def test_case_updates_use_optimistic_locking(db, world):
    s, cid = world["a"]["scope"], world["a"]["case"]["id"]
    updated = repo.update_case(db, s, cid, expected_version=1, status="statement_uploaded", profile={"name": "Demo"},
                               opening_balance=Decimal("1000.00"), questions_issued=2, stopped_reason=None)
    assert updated["version"] == 2 and updated["profile_json"] == {"name": "Demo"}
    assert updated["opening_balance"] == "1000.00" and updated["questions_issued"] == 2
    with pytest.raises(Conflict, match="stale_version"):
        repo.update_case(db, s, cid, expected_version=1, status="processing")
    closed = repo.update_case(db, s, cid, expected_version=2, status="closed")
    assert closed["closed_at"] and closed["version"] == 3
    for bad in ({"firm_id": "x"}, {"client_identity_id": "x"}, {"reference": "IT-X-1"}, {"version": 9}, {}):
        with pytest.raises(InvalidInput):
            repo.update_case(db, s, cid, expected_version=3, **bad)


def test_rotating_a_firm_code(db, world):
    s = world["a"]["scope"]
    new = repo.rotate_firm_code(db, s, "NEWCODEA99")
    assert repo.get_active_firm_code(db, s)["id"] == new["id"]
    with pytest.raises(NotFound):
        repo.find_active_firm_by_code(db, "CODEA2025")
    assert repo.get_case(db, s, world["a"]["case"]["id"])  # existing case unaffected
    repo.revoke_firm_code(db, s, new["id"])
    with pytest.raises(NotFound):
        repo.get_active_firm_code(db, s)


def test_inactive_firm_codes_and_firms_are_not_found(db):
    firm = repo.create_firm(db, name="Pending (synthetic)")
    repo.create_firm_code(db, FirmScope(firm["id"]), "PENDING001")
    with pytest.raises(NotFound):
        repo.find_active_firm_by_code(db, "PENDING001")  # firm not approved


# === invalid IDs and missing records ====================================================================

@pytest.mark.parametrize("bad", ["", "nope", "' OR '1'='1", generate_id().upper(), None])
def test_invalid_ids_are_not_found(db, world, bad):
    s = world["a"]["scope"]
    for call in (lambda: repo.get_case(db, s, bad), lambda: repo.get_ca_user(db, s, bad),
                 lambda: repo.get_document(db, s, world["a"]["case"]["id"], bad),
                 lambda: repo.list_questions(db, s, bad), lambda: repo.get_challenge(db, bad)):
        with pytest.raises(NotFound):
            call()


def test_missing_records_are_not_found(db, world):
    s = world["a"]["scope"]
    missing = generate_id()
    for call in (lambda: repo.get_case(db, s, missing), lambda: repo.get_client_identity(db, s, missing),
                 lambda: repo.update_case(db, s, missing, expected_version=1, status="processing"),
                 lambda: repo.replace_statement_rows(db, s, missing, []),
                 lambda: repo.answer_question(db, s, world["a"]["case"]["id"], "Q-missing", "x"),
                 lambda: repo.get_ca_user_for_login(db, "nobody@example.test")):
        with pytest.raises(NotFound):
            call()


def test_scope_requires_a_valid_firm_id():
    with pytest.raises(InvalidInput):
        FirmScope("not-a-uuid")


# === cross-firm and cross-case access ======================================================================

def test_cross_firm_reads_look_exactly_like_missing_records(db, world):
    a, b = world["a"], world["b"]
    with pytest.raises(NotFound) as other_firm:
        repo.get_case(db, a["scope"], b["case"]["id"])
    with pytest.raises(NotFound) as missing:
        repo.get_case(db, a["scope"], generate_id())
    assert str(other_firm.value) == str(missing.value) == "Not found."
    reads = [
        lambda: repo.get_ca_user(db, a["scope"], b["user"]["id"]),
        lambda: repo.get_client_identity(db, a["scope"], b["client"]["id"]),
        lambda: repo.get_client_case(db, a["scope"], b["client"]["id"], b["case"]["id"]),
        lambda: repo.list_statement_rows(db, a["scope"], b["case"]["id"]),
        lambda: repo.list_questions(db, a["scope"], b["case"]["id"]),
        lambda: repo.list_confirmations(db, a["scope"], b["case"]["id"]),
        lambda: repo.list_document_requests(db, a["scope"], b["case"]["id"]),
        lambda: repo.list_documents(db, a["scope"], b["case"]["id"]),
        lambda: repo.list_audit_events(db, a["scope"], case_id=b["case"]["id"]),
    ]
    for read in reads:
        with pytest.raises(NotFound):
            read()
    assert [c["id"] for c in repo.list_cases(db, a["scope"])] == [a["case"]["id"]]
    assert repo.list_client_cases(db, a["scope"], b["client"]["id"]) == []


def test_cross_firm_writes_are_refused_and_change_nothing(db, world):
    a, b = world["a"], world["b"]
    bs, bcase = b["scope"], b["case"]["id"]
    repo.replace_statement_rows(db, bs, bcase, [row(1)])
    add_q(db, b)
    breq = repo.add_document_request(db, bs, bcase, key="form_16", label="Form 16")
    bdoc = add_doc(db, b)
    writes = [
        lambda: repo.update_case(db, a["scope"], bcase, expected_version=1, status="closed"),
        lambda: repo.replace_statement_rows(db, a["scope"], bcase, []),
        lambda: add_q(db, {"scope": a["scope"], "case": b["case"]}, "Q-000000000009"),
        lambda: repo.answer_question(db, a["scope"], bcase, "Q-000000000001", "hijack"),
        lambda: repo.withdraw_question(db, a["scope"], bcase, "Q-000000000001"),
        lambda: repo.add_confirmation(db, a["scope"], bcase, finding_id="F0001", proposed_category="Family Transfer",
                                      response="confirmed"),
        lambda: repo.add_document_request(db, a["scope"], bcase, key="pan", label="PAN"),
        lambda: repo.set_document_request_status(db, a["scope"], bcase, breq["id"], "waived"),
        lambda: add_doc(db, {"scope": a["scope"]}, case_id=bcase, sha256="b" * 64),
        lambda: repo.set_document_status(db, a["scope"], bcase, bdoc["id"], "rejected"),
        lambda: repo.revoke_firm_code(db, a["scope"], b["code"]["id"]),
        lambda: repo.set_ca_user_status(db, a["scope"], b["user"]["id"], "disabled"),
        lambda: repo.mark_client_email_verified(db, a["scope"], b["client"]["id"]),
        lambda: repo.create_case(db, a["scope"], client_identity_id=b["client"]["id"], first_name="X",
                                 financial_year="2024-25"),
        lambda: repo.create_case(db, a["scope"], client_identity_id=a["client"]["id"], first_name="X",
                                 financial_year="2024-25", firm_code_id=b["code"]["id"]),
    ]
    for write in writes:
        with pytest.raises(NotFound):
            write()
    # Firm B's data is untouched.
    assert repo.get_case(db, bs, bcase)["status"] == "draft"
    assert len(repo.list_statement_rows(db, bs, bcase)) == 1
    assert repo.get_question(db, bs, bcase, "Q-000000000001")["status"] == "pending"
    assert repo.list_confirmations(db, bs, bcase) == []
    assert repo.get_document_request(db, bs, bcase, breq["id"])["status"] == "requested"
    assert repo.get_document(db, bs, bcase, bdoc["id"])["status"] == "stored"
    assert repo.get_active_firm_code(db, bs)["id"] == b["code"]["id"]
    assert repo.get_ca_user(db, bs, b["user"]["id"])["status"] == "pending"
    assert repo.get_client_identity(db, bs, b["client"]["id"])["email_verified_at"] is None
    assert repo.list_cases(db, a["scope"]) == [repo.get_case(db, a["scope"], a["case"]["id"])]


def test_cross_case_related_records_are_not_found(db, world):
    a = world["a"]
    s = a["scope"]
    second_client = repo.get_or_create_client_identity(db, s, "second@example.test")
    case2 = repo.create_case(db, s, client_identity_id=second_client["id"], first_name="Other", financial_year="2025-26")
    req2 = repo.add_document_request(db, s, case2["id"], key="form_16", label="Form 16")
    doc2 = add_doc(db, a, case_id=case2["id"])
    q2 = add_q(db, {"scope": s, "case": case2})
    cid = a["case"]["id"]
    for call in (
        lambda: repo.get_document_request(db, s, cid, req2["id"]),
        lambda: repo.set_document_request_status(db, s, cid, req2["id"], "waived"),
        lambda: repo.get_document(db, s, cid, doc2["id"]),
        lambda: repo.set_document_status(db, s, cid, doc2["id"], "rejected"),
        lambda: repo.get_question(db, s, cid, q2["question_id"]),
        lambda: repo.answer_question(db, s, cid, q2["question_id"], "wrong case"),
        lambda: add_doc(db, a, kind="supporting", request_id=req2["id"], sha256="c" * 64),  # request of another case
        lambda: repo.get_client_case(db, s, second_client["id"], cid),  # client of another case
    ):
        with pytest.raises(NotFound):
            call()
    assert repo.get_question(db, s, case2["id"], q2["question_id"])["status"] == "pending"


def test_session_and_email_and_audit_cannot_cross_firms(db, world):
    a, b = world["a"], world["b"]
    with pytest.raises(NotFound):
        repo.create_session(db, kind="ca", firm_id=a["firm"]["id"], ca_user_id=b["user"]["id"], token_hash="b" * 64,
                            idle_expires_at=LATER, absolute_expires_at=LATER)
    with pytest.raises(NotFound):
        repo.create_session(db, kind="client", firm_id=a["firm"]["id"], client_identity_id=b["client"]["id"],
                            token_hash="c" * 64, idle_expires_at=LATER, absolute_expires_at=LATER)
    with pytest.raises(NotFound):
        repo.enqueue_email(db, idempotency_key="x", template="t", recipient="x@example.test", subject="s",
                           body_text=None, firm_id=a["firm"]["id"], case_id=b["case"]["id"])
    with pytest.raises(NotFound):
        repo.record_audit_event(db, actor_kind="system", action="x", firm_id=a["firm"]["id"], case_id=b["case"]["id"])
    assert repo.revoke_ca_user_sessions(db, a["scope"], b["user"]["id"]) == 0


# === parameterised queries =================================================================================

INJECTION = "x'); DROP TABLE cases; --"


def test_sql_like_strings_are_stored_verbatim(db, world):
    a = world["a"]
    s, cid = a["scope"], a["case"]["id"]
    firm = repo.create_firm(db, name=INJECTION, registration_number="R'; DELETE FROM firms; --")
    assert firm["name"] == INJECTION
    repo.replace_statement_rows(db, s, cid, [row(1, raw_narration=INJECTION, narration=INJECTION,
                                                 counterparty="Robert'); DROP TABLE statement_rows;--")])
    assert repo.list_statement_rows(db, s, cid)[0]["narration"] == INJECTION
    add_q(db, a, question=f"Was {INJECTION} a refund?")
    answered = repo.answer_question(db, s, cid, "Q-000000000001", "' OR 1=1; DELETE FROM questions; --")
    assert answered["answer_text"] == "' OR 1=1; DELETE FROM questions; --"
    repo.add_document_request(db, s, cid, key="form_16", label=INJECTION)
    repo.record_audit_event(db, actor_kind="system", action="note", firm_id=a["firm"]["id"], details={"text": INJECTION})
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"cases", "firms", "statement_rows", "questions"} <= tables
    assert db.execute("SELECT count(*) FROM cases").fetchone()[0] == 2
    assert db.execute("SELECT count(*) FROM firms").fetchone()[0] == 3


@pytest.mark.parametrize("probe", ["' OR '1'='1", "%", "_", "*", "CODEA2025' --"])
def test_injection_like_lookups_find_nothing(db, world, probe):
    for call in (lambda: repo.find_active_firm_by_code(db, probe), lambda: repo.get_ca_user_for_login(db, probe),
                 lambda: repo.get_session_by_token_hash(db, probe)):
        with pytest.raises(NotFound):
            call()
    assert repo.list_cases(db, world["a"]["scope"], status=None)  # untouched


def test_update_case_rejects_injected_column_names(db, world):
    s, cid = world["a"]["scope"], world["a"]["case"]["id"]
    with pytest.raises(InvalidInput):
        repo.update_case(db, s, cid, expected_version=1, **{"status = 'closed', firm_id": "x"})
    with pytest.raises(InvalidInput):
        repo.list_cases(db, s, status="draft' OR '1'='1")


# === transactions =========================================================================================

def test_failed_statement_replacement_rolls_back_everything(db, world):
    s, cid = world["a"]["scope"], world["a"]["case"]["id"]
    repo.replace_statement_rows(db, s, cid, [row(1), row(2)])
    with pytest.raises(InvalidInput):
        repo.replace_statement_rows(db, s, cid, [row(1), row(2), row(3, credit="not money")])
    with pytest.raises(Conflict, match="duplicate_row_number"):
        repo.replace_statement_rows(db, s, cid, [row(1), row(1)])
    with pytest.raises(InvalidInput):
        repo.replace_statement_rows(db, s, cid, [row(1), row(2, category="Made-up category")])
    assert [r["row_number"] for r in repo.list_statement_rows(db, s, cid)] == [1, 2]
    assert not db.in_transaction


def test_failed_rotation_keeps_the_old_code(db, world):
    a, b = world["a"], world["b"]
    with pytest.raises(Conflict, match="firm_code_taken"):
        repo.rotate_firm_code(db, a["scope"], b["code"]["code"])
    assert repo.get_active_firm_code(db, a["scope"])["id"] == a["code"]["id"]
    assert not db.in_transaction


def test_repository_writes_join_an_outer_transaction(db, world):
    from itr_intake_server.db import transaction
    s, cid = world["a"]["scope"], world["a"]["case"]["id"]
    with pytest.raises(RuntimeError):
        with transaction(db):
            repo.replace_statement_rows(db, s, cid, [row(1)])
            add_q(db, world["a"])
            raise RuntimeError("caller aborts")
    assert repo.list_statement_rows(db, s, cid) == [] and repo.list_questions(db, s, cid) == []
    with transaction(db):  # and commit together when the caller commits
        repo.replace_statement_rows(db, s, cid, [row(1)])
        add_q(db, world["a"])
    assert len(repo.list_statement_rows(db, s, cid)) == 1 and len(repo.list_questions(db, s, cid)) == 1


# === constraints still enforced =================================================================================

def test_append_only_records_have_no_update_paths(db, world):
    a = world["a"]
    s, cid = a["scope"], a["case"]["id"]
    repo.add_confirmation(db, s, cid, finding_id="F0008", proposed_category="Family Transfer", response="confirmed")
    repo.record_audit_event(db, actor_kind="system", action="x", firm_id=a["firm"]["id"])
    public = {n for n in dir(repo) if not n.startswith("_")}
    assert not {n for n in public if ("confirmation" in n or "audit" in n) and n.split("_")[0] in
                {"update", "delete", "remove", "set", "edit"}}
    assert not {n for n in public if n.startswith(("delete_", "remove_", "purge_"))}
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        db.execute("UPDATE confirmations SET response = 'denied'")
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        db.execute("DELETE FROM audit_events")


def test_append_only_violations_map_to_not_permitted():
    assert isinstance(repo._translate(sqlite3.IntegrityError("confirmations are append-only")), NotPermitted)


def test_errors_never_leak_database_details(db, world):
    s, cid = world["a"]["scope"], world["a"]["case"]["id"]
    for call in (lambda: repo.replace_statement_rows(db, s, cid, [row(1, category="Bogus")]),
                 lambda: repo.create_firm(db, name="X", registration_number="FRN-A-SYN"),
                 lambda: repo.get_case(db, s, generate_id())):
        with pytest.raises(repo.RepositoryError) as info:
            call()
        message = str(info.value)
        assert "constraint" not in message.lower() and "sqlite" not in message.lower()
        assert "Bogus" not in message and "FRN-A-SYN" not in message
        assert info.value.__cause__ is None or not isinstance(info.value.__cause__, sqlite3.Error)


def test_one_open_case_rule_is_intact(db, world):
    a = world["a"]
    s = a["scope"]
    with pytest.raises(Conflict, match="open_case_exists"):
        repo.create_case(db, s, client_identity_id=a["client"]["id"], first_name="Demo", financial_year="2025-26")
    repo.update_case(db, s, a["case"]["id"], expected_version=1, status="submitted")
    with pytest.raises(Conflict, match="open_case_exists"):
        repo.create_case(db, s, client_identity_id=a["client"]["id"], first_name="Demo", financial_year="2025-26")
    repo.update_case(db, s, a["case"]["id"], expected_version=2, status="closed")
    newer = repo.create_case(db, s, client_identity_id=a["client"]["id"], first_name="Demo", financial_year="2025-26")
    with pytest.raises(Conflict, match="open_case_exists"):  # re-opening the old one is blocked
        repo.update_case(db, s, a["case"]["id"], expected_version=3, status="draft")
    assert repo.find_open_case(db, s, a["client"]["id"], "2025-26")["id"] == newer["id"]


def test_registration_number_rule_is_intact(db, world):
    with pytest.raises(Conflict, match="registration_number_taken"):
        repo.create_firm(db, name="Branch (synthetic)", registration_number="FRN-A-SYN")
    repo.create_firm(db, name="Unregistered 1 (synthetic)")
    repo.create_firm(db, name="Unregistered 2 (synthetic)")


def test_other_uniqueness_rules_map_to_conflicts(db, world):
    a = world["a"]
    with pytest.raises(Conflict, match="email_taken"):
        repo.create_ca_user(db, firm_id=a["firm"]["id"], email="CA-A@example.test", full_name="Dup", password_hash="h")
    with pytest.raises(Conflict, match="active_firm_code_exists"):
        repo.create_firm_code(db, a["scope"], "ANOTHER123")
    add_q(db, a)
    with pytest.raises(Conflict, match="pending_question_exists"):
        add_q(db, a, "Q-000000000002")
    repo.answer_question(db, a["scope"], a["case"]["id"], "Q-000000000001", "First answer.")
    with pytest.raises(Conflict, match="question_not_pending"):
        repo.answer_question(db, a["scope"], a["case"]["id"], "Q-000000000001", "Second answer.")
    assert repo.get_question(db, a["scope"], a["case"]["id"], "Q-000000000001")["answer_text"] == "First answer."
    add_doc(db, a)
    with pytest.raises(Conflict, match="duplicate_document"):
        add_doc(db, a)


def test_document_storage_keys_are_generated_not_chosen(db, world):
    a = world["a"]
    for bad in ("../pdf", "pdf/x", "PDF", "", "exe ", "a" * 9):
        with pytest.raises(InvalidInput):
            add_doc(db, a, extension=bad, sha256="d" * 64)
    with pytest.raises(TypeError):
        add_doc(db, a, storage_key="elsewhere/x.pdf")


def test_tests_never_touch_the_default_database(tmp_path, world, db):
    # The `db` fixture lives in tmp_path; the default database (which may exist
    # from real local use) is never what tests open. backend/var as a whole is
    # also guarded for the entire run by conftest.real_database_is_never_touched.
    path = db.execute("PRAGMA database_list").fetchone()["file"]
    assert path.startswith(str(tmp_path)) and path != str(DEFAULT_DATABASE_PATH)
