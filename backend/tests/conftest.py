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
