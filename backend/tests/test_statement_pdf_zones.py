"""Start-anchored column bands and same-page headers for PDF statements.

All dates, narrations and amounts are invented. PDF-level tests use the local
xpdf `pdftotext` (skipped and reported if it is missing); boundary tests feed
hand-made page text straight to the parser so character positions are exact.
"""

import random
from decimal import Decimal

import pytest

import synthetic_pdf as sp
from itr_intake import statement_import as si
from itr_intake_server import statements

PDFTOTEXT = statements.find_pdftotext()
needs_pdf = pytest.mark.skipif(PDFTOTEXT is None, reason="xpdf pdftotext is not available")
CW = sp.CHAR_W
FY = "2025-26"

ROWS_P1 = [("01/04/2025", "UPI SYN SHOP 0001", "250.00", "", "9,750.00"),
           ("02/04/2025", "NEFT SYN SALARY", "", "45,000.00", "54,750.00"),
           ("03/04/2025", "ATM SYN 0002", "2,000.00", "", "52,750.00"),
           ("04/04/2025", "UPI SYN CAFE", "120.50", "", "52,629.50")]
ROWS_P2 = [("05/04/2025", "SYN INTEREST", "", "15.25", "52,644.75"),
           ("06/04/2025", "UPI SYN GROCER", "1,644.75", "", "51,000.00")]


# === the band rule itself (exact character positions) ==========================================================

def header(debit=(60, 65), credit=(80, 86), balance=(100, 107)):
    return si._Header({"date": (0, 4), "narration": (12, 23), "debit": debit, "credit": credit, "balance": balance})


@pytest.mark.parametrize("start, end, column", [
    (60, 68, "debit"),     # starts under its label, ends inside the debit band
    (70, 79, "debit"),     # right-aligned in a wide column, ends one before the next label
    (78, 86, "credit"),    # ends inside the credit band
    (96, 107, "balance"),  # wider than its label, reaching left into the credit band
    (120, 131, "balance"), # the last band runs to the end of the line
])
def test_amounts_go_to_the_band_holding_their_last_character(start, end, column):
    assert si._assign(start, end, header()) == column


@pytest.mark.parametrize("start, end, why", [
    (72, 80, "ends against the Credit label (touching the boundary)"),
    (92, 100, "ends against the Balance label"),
    (40, 59, "ends before the first amount label"),
    (55, 90, "spans the whole Debit column"),
    (75, 105, "starts before the Credit label and ends in the Balance band, crossing a column"),
])
def test_boundary_and_spanning_amounts_are_ambiguous(start, end, why):
    assert si._assign(start, end, header()) is None, why


def test_only_two_amount_columns_still_work():
    two = si._Header({"date": (0, 4), "debit": (60, 65), "balance": (90, 97)})
    assert si._assign(60, 70, two) == "debit" and si._assign(85, 97, two) == "balance"
    assert si._assign(80, 90, two) is None  # touches the Balance label


def text_page(rows, *, debit_end_col=None):
    """Hand-made `pdftotext -simple`-style page text with exact columns:
    Debit label at 60, Credit at 80, Balance at 100."""
    lines = ["SYNTHETIC BANK STATEMENT FOR TESTING ONLY", "",
             "Date        Particulars" + " " * 37 + "Debit" + " " * 15 + "Credit" + " " * 14 + "Balance"]
    for d, narr, dr, cr, bal in rows:
        line = list(f"{d}  {narr}".ljust(130))
        for value, end in ((dr, debit_end_col or 70), (cr, 90), (bal, 112)):
            if value:
                line[end - len(value):end] = value
        lines.append("".join(line).rstrip())
    return "\n".join(lines)


def test_a_row_whose_amount_touches_the_boundary_is_rejected():
    rows = [("01/04/2025", "SYN A", "250.00", "", "9,750.00"), ("02/04/2025", "SYN B", "100.00", "", "9,650.00")]
    ok = si.parse_pdf_pages([text_page(rows)], financial_year=FY)
    assert ok.status == si.EXTRACTED and [t.debit for t in ok.transactions] == ["250.00", "100.00"]
    touching = si.parse_pdf_pages([text_page(rows, debit_end_col=80)], financial_year=FY)  # ends at the Credit label
    assert touching.status == si.MANUAL_REVIEW and touching.transactions == ()
    assert {x.codes for x in touching.rejected} == {("ambiguous_columns",)}


# === layouts that the old overlap rule rejected ===============================================================

def text_at(page, x, y, s, align):
    width = len(s) * CW
    page.text(x if align == "left" else x - width if align == "right" else x - width / 2, y, s)


def layout_page(cols, rows, *, header_row=True, opening=None, shift=0.0):
    """cols: [(key, label, label_x, align, amount_right_x)] for debit/credit/balance."""
    page = sp.Page()
    y = sp.PAGE_H - 40
    page.text(40, y, "SYNTHETIC BANK STATEMENT FOR TESTING ONLY")
    y -= 30
    if header_row:
        page.text(40, y, "Date")
        page.text(130, y, "Particulars")
        for _, label, lx, align, _ in cols:
            text_at(page, lx, y, label, align)
        y -= 16
    rights = {key: right for key, _, _, _, right in cols}
    if opening:
        page.text(130, y, "Opening Balance")
        text_at(page, rights["balance"], y, opening, "right")
        y -= 14
    for d, narr, dr, cr, bal in rows:
        page.text(40, y, d)
        page.text(130, y, narr)
        for key, value in (("debit", dr), ("credit", cr), ("balance", bal)):
            if value:
                text_at(page, rights[key] + shift, y, value, "right")
        y -= 14
    page.text(40, 30, "Page footer - computer generated synthetic statement")
    return page


LEFT_SHORT = [("debit", "Debit", 470, "left", 575), ("credit", "Credit", 590, "left", 690),
              ("balance", "Balance", 705, "left", 800)]
CENTRED = [("debit", "Debit", 525, "centre", 575), ("credit", "Credit", 640, "centre", 690),
           ("balance", "Balance", 752, "centre", 800)]


def extract(tmp_path, pages):
    path = tmp_path / f"z{len(list(tmp_path.iterdir()))}.pdf"
    path.write_bytes(sp.build_pdf(pages))
    texts = statements.extract_pdf_pages(PDFTOTEXT, path, tmp_path)
    path.unlink()
    return si.parse_pdf_pages(texts, financial_year=FY)


def values(r):
    return [(t.date, t.debit, t.credit, t.balance) for t in r.transactions]


def expected(rows):
    return [(d, dr or None, cr or None, bal) for d, _, dr, cr, bal in rows]


@needs_pdf
@pytest.mark.parametrize("cols", [LEFT_SHORT, CENTRED], ids=["labels-left-of-wide-columns", "labels-centred"])
def test_left_and_centred_labels_are_read_exactly(tmp_path, cols):
    r = extract(tmp_path, [layout_page(cols, ROWS_P1, opening="10,000.00"), layout_page(cols, ROWS_P2)])
    assert r.status == si.EXTRACTED, (r.review_reasons, r.rejected)
    assert values(r) == expected(ROWS_P1 + ROWS_P2)


# === same-page headers ==========================================================================================

@needs_pdf
@pytest.mark.parametrize("shift", [0.0, -115.0], ids=["same-geometry", "shifted-geometry"])
def test_rows_on_a_page_without_its_own_header_are_rejected(tmp_path, shift):
    r = extract(tmp_path, [layout_page(LEFT_SHORT, ROWS_P1, opening="10,000.00"),
                           layout_page(LEFT_SHORT, ROWS_P2, header_row=False, shift=shift)])
    assert r.status == si.MANUAL_REVIEW
    assert values(r) == expected(ROWS_P1)  # page 1 kept exactly; nothing read from page 2
    assert [(x.row_number, x.codes, x.page) for x in r.rejected] == [
        (5, ("no_header_on_page",), 2), (6, ("no_header_on_page",), 2)]
    assert si.PageWarning(2, "no_header_on_page") in r.page_warnings


@needs_pdf
def test_a_page_with_its_own_header_after_a_shift_is_read(tmp_path):
    shifted = [(k, label, lx - 100, align, right - 100) for k, label, lx, align, right in LEFT_SHORT]
    r = extract(tmp_path, [layout_page(LEFT_SHORT, ROWS_P1, opening="10,000.00"), layout_page(shifted, ROWS_P2)])
    assert r.status == si.EXTRACTED and values(r) == expected(ROWS_P1 + ROWS_P2)


@needs_pdf
def test_a_headerless_first_page_is_still_not_read(tmp_path):
    r = extract(tmp_path, [layout_page(LEFT_SHORT, ROWS_P1, header_row=False)])
    assert r.transactions == () and r.status == si.MANUAL_REVIEW and "unsupported_layout" in r.review_reasons


# === randomised: anything marked extracted must be exactly right ==================================================

DEBIT_LABELS = ("Withdrawals", "Debit", "Withdrawal Amt", "Debit Amount")
CREDIT_LABELS = ("Deposits", "Credit", "Deposit Amt", "Credit Amount")
BALANCE_LABELS = ("Balance", "Closing Balance", "Running Balance")
NARRATIONS = ("UPI SYN SHOP", "NEFT SYN PAYROLL", "ATM SYN CASH", "IMPS SYN TRANSFER", "SYN CARD PAYMENT",
              "SYN INTEREST", "CHQ SYN 000123", "SYN RENT")


def money(value: Decimal) -> str:
    whole, frac = f"{value:.2f}".split(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        whole = ",".join(([head] if head else []) + groups + [tail])
    return f"{whole}.{frac}"


def random_statement(rng: random.Random):
    """Random column geometry and label alignment, invented rows with a true running balance."""
    widths = [rng.uniform(88, 100) for _ in range(3)]
    right = rng.uniform(560, 590)
    rights = []
    for i in range(3):
        rights.append(right)
        right += widths[min(i + 1, 2)] + rng.uniform(12, 25)
    if rights[-1] > 830:
        rights = [r - (rights[-1] - 830) for r in rights]
    cols = []
    for key, labels, r, w in zip(("debit", "credit", "balance"), (DEBIT_LABELS, CREDIT_LABELS, BALANCE_LABELS),
                                 rights, widths):
        label = rng.choice(labels)
        align = rng.choice(("left", "centre", "right"))
        lx = {"left": r - w, "centre": r - w / 2, "right": r}[align]
        cols.append((key, label, lx, align, r))
    balance = Decimal(rng.randint(10_000, 500_000)) + Decimal(rng.randint(0, 99)) / 100
    opening = money(balance)
    pages, all_rows = [], []
    day = 1
    for _ in range(rng.randint(1, 3)):
        rows = []
        for _ in range(rng.randint(2, 7)):
            amount = Decimal(rng.randint(1, 4_000_000)) / 100
            if rng.random() < 0.5 and amount < balance:
                balance -= amount
                dr, cr = money(amount), ""
            else:
                balance += amount
                dr, cr = "", money(amount)
            rows.append((f"{day:02d}/05/2025", rng.choice(NARRATIONS), dr, cr, money(balance)))
            day += 1
        pages.append(rows)
        all_rows += rows
    return cols, opening, pages, all_rows


def build(cols, opening, pages, *, perturb: str | None, rng: random.Random):
    built = []
    for i, rows in enumerate(pages):
        draw_rows = list(rows)
        header_row = True
        shift = 0.0
        if perturb == "headerless_continuation" and i > 0:
            header_row = False
        if perturb == "shift_page" and i == len(pages) - 1:
            shift = rng.choice((-1, 1)) * rng.uniform(15, 70)
        if perturb == "swap_one_row" and i == 0:
            j = rng.randrange(len(draw_rows))
            d, n, dr, cr, bal = draw_rows[j]
            draw_rows[j] = (d, n, cr, dr, bal)  # amount drawn in the wrong column; balance still the true one
        built.append(layout_page(cols, draw_rows, header_row=header_row, opening=opening if i == 0 else None,
                                 shift=shift))
    return built


@needs_pdf
@pytest.mark.parametrize("seed", [11, 23, 37])
def test_randomised_statements_are_never_extracted_wrongly(tmp_path, seed):
    rng = random.Random(seed)
    tally = {"clean_extracted": 0, "clean_total": 0, "perturbed_extracted": 0}
    for case in range(24):
        cols, opening, pages, rows = random_statement(rng)
        perturb = None if case % 2 == 0 else rng.choice(("headerless_continuation", "shift_page", "swap_one_row"))
        r = extract(tmp_path, build(cols, opening, pages, perturb=perturb, rng=rng))
        if r.status == si.EXTRACTED:
            # The core guarantee: an extracted statement is exactly the invented one.
            assert values(r) == expected(rows), (seed, case, perturb, cols)
            assert r.rejected == () and r.page_warnings == ()
        if perturb is None:
            tally["clean_total"] += 1
            tally["clean_extracted"] += r.status == si.EXTRACTED
        else:
            tally["perturbed_extracted"] += r.status == si.EXTRACTED
        if perturb == "swap_one_row":
            assert r.status != si.EXTRACTED, (seed, case, "a misdrawn amount must never be extracted")
        if perturb == "headerless_continuation" and len(pages) > 1:
            assert r.status != si.EXTRACTED and any("no_header_on_page" in x.codes for x in r.rejected)
    # The rule must actually read ordinary layouts, not just reject everything.
    # Clean layouts whose amounts end within about 2-3 characters of the next
    # column's label are (deliberately) sent to manual review, either as
    # `ambiguous_columns` or through the balance chain; at the time of writing
    # 32 of 36 clean layouts across these seeds were extracted.
    assert tally["clean_extracted"] * 3 >= tally["clean_total"] * 2, tally


def test_tightly_packed_columns_go_to_manual_review_not_extracted(tmp_path):
    if PDFTOTEXT is None:
        pytest.skip("xpdf pdftotext is not available")
    # Right-aligned debit label and amounts end only ~13 pt before a left-aligned Credit label.
    tight = [("debit", "Withdrawal Amt", 523, "centre", 568), ("credit", "Credit", 581, "left", 675),
             ("balance", "Balance", 744, "centre", 793)]
    r = extract(tmp_path, [layout_page(tight, ROWS_P1, opening="10,000.00")])
    if r.status == si.EXTRACTED:
        assert values(r) == expected(ROWS_P1)  # only ever acceptable if exactly right
    else:
        assert r.status == si.MANUAL_REVIEW
