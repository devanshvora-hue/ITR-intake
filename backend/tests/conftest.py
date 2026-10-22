"""Shared fixtures. All data here is synthetic."""

from datetime import date
from decimal import Decimal

import pytest

from itr_intake import (
    BankAccount,
    Category,
    ClientProfile,
    ClientRule,
    Direction,
    FamilyMember,
    Transaction,
)
from itr_intake.text import detect_mode, extract_counterparty


def var_dir_state() -> dict:
    """Name -> (size, mtime) for everything in backend/var (the real local
    database directory). Tests must never change it."""
    from itr_intake_server.db import VAR_DIR

    if not VAR_DIR.exists():
        return {}
    return {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in VAR_DIR.iterdir()}


@pytest.fixture(scope="session", autouse=True)
def real_database_is_never_touched():
    """Fails the run if any test created, modified or deleted files in
    backend/var. Tests must use temporary databases only."""
    before = var_dir_state()
    yield
    assert var_dir_state() == before, "a test touched backend/var; use a temporary database"


@pytest.fixture
def profile() -> ClientProfile:
    return ClientProfile(
        name="Arjun Mehta",
        accounts=(
            BankAccount("Example Bank", "50100012345678", ("EXAMPLE BANK",)),
            BankAccount("SBI", "39876543210", ("SBI", "SBIN")),
        ),
        upi_ids=("arjun.demo@okexample",),
        mobile_numbers=("9800000001",),
        family_members=(
            FamilyMember("Priya Mehta", "spouse"),
            FamilyMember("Suresh Mehta", "father"),
        ),
        employers=("Examplesoft Technologies Pvt Ltd",),
        loan_account_numbers=("0012345",),
        client_rules=(
            ClientRule("Food delivery is personal.", (r"\bSWIGGY\b",), Category.PERSONAL_EXPENSES, Direction.DEBIT),
        ),
    )


def make_txn(
    narration: str,
    *,
    debit: str = "0",
    credit: str = "0",
    on: date = date(2025, 4, 1),
    row: int = 1,
) -> Transaction:
    return Transaction(
        row_number=row,
        date=on,
        narration=narration,
        debit=Decimal(debit),
        credit=Decimal(credit),
        balance=None,
        raw_debit=debit,
        raw_credit=credit,
        raw_balance=None,
        mode=detect_mode(narration),
        counterparty=extract_counterparty(narration),
    )
