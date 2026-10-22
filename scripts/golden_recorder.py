# Regenerate tests/fixtures/classifier-golden.json from the Python classifier:
#   PYTHONPATH=scripts GOLDEN_OUT=tests/fixtures/classifier-golden.json \
#     .venv/Scripts/python -m pytest backend/tests/test_classifier.py backend/tests/test_classifier_reliability.py \
#     backend/tests/test_synthetic_dataset.py backend/tests/test_workbook.py backend/tests/test_case_review.py -p golden_recorder -q
"""pytest plugin: record every classify_statement / classify_transaction call
(profile, transactions, results) into a JSON fixture for the TypeScript port."""
import dataclasses, json, os
from decimal import Decimal
import itr_intake.classifier as clf

CASES = []

def _prof(p):
    return {
        "name": p.name,
        "accounts": [{"bankName": a.bank_name, "accountNumber": a.account_number, "bankIdentifiers": list(a.bank_identifiers)} for a in p.accounts],
        "upiIds": list(p.upi_ids), "mobileNumbers": list(p.mobile_numbers),
        "familyMembers": [{"name": f.name, "relation": f.relation, "aliases": list(f.aliases)} for f in p.family_members],
        "employers": list(p.employers), "loanAccountNumbers": list(p.loan_account_numbers),
        "clientRules": [{"description": r.description, "patterns": list(r.patterns), "category": str(r.category),
                         **({"direction": str(r.direction)} if r.direction else {})} for r in p.client_rules],
    }

def _paise(d):
    return None if d is None else str(int((Decimal(d) * 100).to_integral_value()))

def _txn(t):
    return {"rowNumber": t.row_number, "date": t.date.isoformat(), "narration": t.narration,
            "debit": _paise(t.debit), "credit": _paise(t.credit), "balance": _paise(t.balance)}

def _out(t):
    return {"rowNumber": t.row_number, "category": str(t.category), "confidence": str(t.confidence),
            "reviewStatus": str(t.review_status), "matchedRule": t.matched_rule, "flags": list(t.flags),
            "reason": t.classification_reason, "mode": str(t.mode), "counterparty": t.counterparty}

_orig = clf.classify_statement

def recording(transactions, profile, config=clf.DEFAULT_CONFIG):
    result = _orig(transactions, profile, config)
    if config is clf.DEFAULT_CONFIG or config == clf.DEFAULT_CONFIG:
        CASES.append({"profile": _prof(profile), "transactions": [_txn(t) for t in transactions],
                      "expected": [_out(t) for t in result]})
    return result

_orig_one = clf.classify_transaction

def recording_one(t, profile, config=clf.DEFAULT_CONFIG):
    result = _orig_one(t, profile, config)
    if config is clf.DEFAULT_CONFIG or config == clf.DEFAULT_CONFIG:
        CASES.append({"single": True, "profile": _prof(profile), "transactions": [_txn(t)],
                      "expected": [_out(result)] if result is not None else [None]})
    return result

def _patch_all():
    import sys as _sys
    for mod in list(_sys.modules.values()):
        try:
            if getattr(mod, "classify_statement", None) is _orig:
                setattr(mod, "classify_statement", recording)
            if getattr(mod, "classify_transaction", None) is _orig_one and mod is not clf:
                setattr(mod, "classify_transaction", recording_one)
        except Exception:
            pass

def pytest_configure(config):
    clf.classify_statement = recording

def pytest_runtest_setup(item):
    _patch_all()

def pytest_unconfigure(config):
    from itr_intake.synthetic import load_synthetic_statement, BALANCED, UNBALANCED
    from itr_intake.validation import validate_statement
    for name in (BALANCED, UNBALANCED):
        s = load_synthetic_statement(name)
        report = validate_statement(s.rows, s.opening_balance, s.closing_balance)
        recording(list(report.transactions), s.profile)
    seen, unique = set(), []
    for c in CASES:
        key = json.dumps(c, sort_keys=True)
        if key not in seen:
            seen.add(key); unique.append(c)
    out = os.environ["GOLDEN_OUT"]
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"_notice": "SYNTHETIC test data. Expected results recorded from the Python classifier (backend/itr_intake).",
                   "cases": unique}, fh, ensure_ascii=False, indent=1)
    print(f"\nrecorded {len(unique)} classifier cases")
