"""A tiny PDF writer for synthetic test statements (standard library only).

It produces real, uncompressed PDF files with text drawn at chosen
positions (Courier), optional image-only pages (a small grey image and no
text), and optional mixed pages (a text header plus an image instead of the
table). No real data: callers pass synthetic rows.
"""

import zlib

PAGE_W, PAGE_H = 842, 595  # A4 landscape, points


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


class Page:
    def __init__(self) -> None:
        self.ops: list[str] = []
        self.has_image = False

    def text(self, x: float, y: float, s: str, size: int = 9) -> "Page":
        self.ops.append(f"BT /F1 {size} Tf {x:.1f} {y:.1f} Td ({_escape(s)}) Tj ET")
        return self

    def image(self, x: float, y: float, w: float, h: float) -> "Page":
        self.has_image = True
        self.ops.append(f"q {w:.1f} 0 0 {h:.1f} {x:.1f} {y:.1f} cm /Im1 Do Q")
        return self


def build_pdf(pages: list[Page], *, compress: bool = False) -> bytes:
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    catalog = add(b"")  # placeholder, filled below
    pages_obj = add(b"")
    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>")
    pixels = bytes([128]) * (8 * 8)
    image = add(b"<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray "
                b"/BitsPerComponent 8 /Length %d >>\nstream\n" % len(pixels) + pixels + b"\nendstream")
    kids = []
    for page in pages:
        content = "\n".join(page.ops).encode("latin-1")
        if compress:
            data = zlib.compress(content)
            stream = add(b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(data) + data + b"\nendstream")
        else:
            stream = add(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
        resources = f"<< /Font << /F1 {font} 0 R >> /XObject << /Im1 {image} 0 R >> >>"
        kids.append(add(f"<< /Type /Page /Parent {pages_obj} 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
                        f"/Resources {resources} /Contents {stream} 0 R >>".encode()))
    objects[catalog - 1] = f"<< /Type /Catalog /Pages {pages_obj} 0 R >>".encode()
    objects[pages_obj - 1] = (f"<< /Type /Pages /Count {len(kids)} /Kids ["
                              + " ".join(f"{k} 0 R" for k in kids) + "] >>").encode()

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root {catalog} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


# --- a synthetic statement layout ------------------------------------------------------------------

# Column x positions (points). Amount columns are right-aligned at these edges.
COL_DATE, COL_NARR, COL_DEBIT_R, COL_CREDIT_R, COL_BAL_R = 40, 130, 560, 660, 790
CHAR_W = 9 * 0.6  # Courier advance at 9 pt


def _right(page: Page, right_edge: float, y: float, s: str) -> None:
    page.text(right_edge - len(s) * CHAR_W, y, s)


def statement_page(rows: list[tuple[str, str, str, str, str]], *, header: bool = True,
                   title: str = "SYNTHETIC BANK - ACCOUNT STATEMENT", opening: str | None = None,
                   closing: str | None = None, page_no: int | None = None,
                   labels: tuple[str, str, str, str, str] = ("Date", "Particulars", "Withdrawals", "Deposits", "Balance"),
                   ) -> Page:
    """One page with a header row and transaction rows
    (date, narration, debit, credit, balance); narrations may contain '\\n'
    to wrap onto a second line."""
    page = Page()
    y = PAGE_H - 40
    page.text(COL_DATE, y, title, 11)
    y -= 16
    page.text(COL_DATE, y, "Account holder: Synthetic Person   Account: XXXXXXXX0000")
    y -= 24
    if header:
        page.text(COL_DATE, y, labels[0])
        page.text(COL_NARR, y, labels[1])
        _right(page, COL_DEBIT_R, y, labels[2])
        _right(page, COL_CREDIT_R, y, labels[3])
        _right(page, COL_BAL_R, y, labels[4])
        y -= 16
    if opening is not None:
        page.text(COL_NARR, y, "Opening Balance")
        _right(page, COL_BAL_R, y, opening)
        y -= 14
    for date, narration, debit, credit, balance in rows:
        lines = narration.split("\n")
        page.text(COL_DATE, y, date)
        page.text(COL_NARR, y, lines[0])
        if debit:
            _right(page, COL_DEBIT_R, y, debit)
        if credit:
            _right(page, COL_CREDIT_R, y, credit)
        if balance:
            _right(page, COL_BAL_R, y, balance)
        for extra in lines[1:]:
            y -= 12
            page.text(COL_NARR, y, extra)
        y -= 14
    if closing is not None:
        page.text(COL_NARR, y, "Closing Balance")
        _right(page, COL_BAL_R, y, closing)
        y -= 14
    if page_no is not None:
        page.text(COL_DATE, 30, f"Page {page_no}   This is a computer generated statement.")
    return page


def image_only_page() -> Page:
    return Page().image(40, 40, 760, 500)


def mixed_page(title: str = "SYNTHETIC BANK - ACCOUNT STATEMENT") -> Page:
    """A header in real text, but the table is an image (not extractable)."""
    page = Page()
    page.text(COL_DATE, PAGE_H - 40, title, 11)
    page.text(COL_DATE, PAGE_H - 56, "Account holder: Synthetic Person   Account: XXXXXXXX0000")
    page.text(COL_DATE, PAGE_H - 80, "Date")
    page.text(COL_NARR, PAGE_H - 80, "Particulars")
    _right(page, COL_DEBIT_R, PAGE_H - 80, "Withdrawals")
    _right(page, COL_CREDIT_R, PAGE_H - 80, "Deposits")
    _right(page, COL_BAL_R, PAGE_H - 80, "Balance")
    return page.image(40, 60, 760, 440)


def blank_page() -> Page:
    return Page()
