"""Generate the internal workbook from the bundled SYNTHETIC statement.

Usage (from the project root):
    .venv/Scripts/python backend/scripts/generate_demo_workbook.py [output.xlsx] [--unbalanced]

The default output goes to the system temp directory, never the project root.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from itr_intake import classify_statement, validate_statement  # noqa: E402
from itr_intake.synthetic import BALANCED, UNBALANCED, load_synthetic_statement  # noqa: E402
from itr_intake.workbook import StatementMetadata, build_workbook, save_workbook  # noqa: E402


def main(argv: list[str]) -> int:
    unbalanced = "--unbalanced" in argv
    args = [a for a in argv if not a.startswith("--")]
    name = "itr_intake_demo_unbalanced.xlsx" if unbalanced else "itr_intake_demo.xlsx"
    out = Path(args[0]) if args else Path(tempfile.gettempdir()) / name

    s = load_synthetic_statement(UNBALANCED if unbalanced else BALANCED)
    report = validate_statement(
        s.rows, s.opening_balance, s.closing_balance,
        period_start=s.period_start, period_end=s.period_end,
    )
    classified = classify_statement(report.transactions, s.profile)
    meta = StatementMetadata(
        client_name=s.profile.name,
        client_reference="DEMO-0142",
        bank_name=s.profile.accounts[0].bank_name,
        account_number=s.profile.accounts[0].account_number,
        financial_year="FY 2025-26",
        period_start=s.period_start,
        period_end=s.period_end,
        data_source_note="SYNTHETIC DEMO DATA – fictional client",
    )
    path = save_workbook(build_workbook(report, classified, meta), out)
    print(f"Wrote {path} (reconciliation: {report.reconciliation.status})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
