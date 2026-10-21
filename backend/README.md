# ITR Intake backend

Deterministic bank-transaction validation and classification (Stage 2).
Business logic lives in `itr_intake/` and has no FastAPI dependency.

- `itr_intake/categories.py` – the 28 canonical categories
- `itr_intake/models.py` – typed raw and validated transaction records
- `itr_intake/validation.py` – row validation and balance reconciliation
- `itr_intake/classifier.py` – priority-ordered classifier
- `itr_intake/rules.py` – default narration rules (bank-generated, identifiable sources)
- `itr_intake/config.py` – client profile and configurable thresholds
- `itr_intake/workbook.py` – internal Excel workbook for CA review (never shown to clients)
- `itr_intake/sample_data/` – **synthetic** demo statements (no real customer data)
- `scripts/generate_demo_workbook.py` – builds a workbook from the synthetic statement

Classification rules and settings are documented in
[`../docs/classification-spec.md`](../docs/classification-spec.md).
This module does not compute tax or decide whether any amount is taxable,
exempt or deductible.

## Run the tests

From the project root, using the project-local virtual environment:

```bash
.venv/Scripts/python -m pytest backend
```

(On macOS/Linux: `.venv/bin/python -m pytest backend`.)

## Generate a demo workbook

```bash
.venv/Scripts/python backend/scripts/generate_demo_workbook.py
```

This writes `itr_intake_demo.xlsx` to the system temp directory (pass an output
path to change it, or `--unbalanced` for the failed-reconciliation example).
Formulas are calculated when the file is opened in Excel.
