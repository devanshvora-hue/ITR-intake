"""Loader for the bundled synthetic demo statements (sample_data/*.json).

These files contain fictional data only and are clearly labelled as such.
"""

import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from .categories import Category
from .config import BankAccount, ClientProfile, ClientRule, FamilyMember
from .models import Direction, RawTransaction

SAMPLE_DIR = Path(__file__).parent / "sample_data"
BALANCED = "synthetic_statement_balanced.json"
UNBALANCED = "synthetic_statement_unbalanced.json"


@dataclass(frozen=True)
class SyntheticStatement:
    notice: str
    description: str
    period_start: date
    period_end: date
    opening_balance: str
    closing_balance: str
    profile: ClientProfile
    rows: list[RawTransaction]


def _profile(data: dict) -> ClientProfile:
    return ClientProfile(
        name=data["name"],
        accounts=tuple(
            BankAccount(a["bank_name"], a["account_number"], tuple(a.get("bank_identifiers", ())))
            for a in data.get("accounts", ())
        ),
        upi_ids=tuple(data.get("upi_ids", ())),
        mobile_numbers=tuple(data.get("mobile_numbers", ())),
        family_members=tuple(
            FamilyMember(f["name"], f["relation"], tuple(f.get("aliases", ())))
            for f in data.get("family_members", ())
        ),
        employers=tuple(data.get("employers", ())),
        loan_account_numbers=tuple(data.get("loan_account_numbers", ())),
        client_rules=tuple(
            ClientRule(
                description=r["description"],
                patterns=tuple(r["patterns"]),
                category=Category(r["category"]),
                direction=Direction(r["direction"]) if r.get("direction") else None,
            )
            for r in data.get("client_rules", ())
        ),
    )


def load_synthetic_statement(filename: str = BALANCED) -> SyntheticStatement:
    data = json.loads((SAMPLE_DIR / filename).read_text(encoding="utf-8"))
    if "SYNTHETIC" not in data.get("_notice", ""):
        raise ValueError(f"{filename} is not labelled as synthetic data")
    return SyntheticStatement(
        notice=data["_notice"],
        description=data["description"],
        period_start=date.fromisoformat(data["period_start"]),
        period_end=date.fromisoformat(data["period_end"]),
        opening_balance=data["opening_balance"],
        closing_balance=data["closing_balance"],
        profile=_profile(data["client_profile"]),
        rows=[
            RawTransaction(
                row_number=r["row_number"],
                date=r["date"],
                narration=r["narration"],
                debit=r.get("debit"),
                credit=r.get("credit"),
                balance=r.get("balance"),
            )
            for r in data["transactions"]
        ],
    )
