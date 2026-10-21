"""Default narration rules for priority levels 3 (bank-generated) and 4
(specific identifiable sources).

Categories describe what a transaction appears to be. They are not tax
conclusions: whether anything is taxable, exempt or deductible is for the CA
to decide from supporting documents.
"""

from .categories import Category
from .config import KeywordRule
from .models import Confidence, Direction, ReviewStatus

# Patterns run against the normalised narration: upper case, punctuation
# replaced by single spaces. Short abbreviations (SAL, MF, DIV, EMI, SIP, ITD,
# TDS, CHG...) are only accepted next to words that give them context.

# Broad on purpose: used to keep tax-department credits out of the generic
# refund rule, never to classify on its own.
_TAX_DEPARTMENT_ANY = (r"\bITD\b", r"\bCBDT\b", r"\bINCOME ?TAX\b", r"\bTAX REFUND\b", r"\bIT REFUND\b")

_TAX_REFUND = (
    r"\bINCOME ?TAX REFUND\b",
    r"\b(TAX|IT) REFUND\b",
    r"\bCBDT\b",
    r"\bITD\b.*\bREFUND\b",
    r"\bREFUND\b.*\bITD\b",
)

# A narration that is a transfer to or from a named party, not a bank entry.
_PARTY_TRANSFER = (
    r"^UPI\b",
    r"^(NEFT|RTGS|IMPS) (DR|CR|P2A|P2P|IN|OUT)\b",
    r"^IMPS P2A\b",
    r"^(N?ACH|ECS) (D|DR|C|CR)\b",
    r"^(TO|BY) TRANSFER\b",
)

_CHARGE = r"(CHRG|CHGS?|CHARGES?|FEES?)"
_BANK_CHARGE_PATTERNS = (
    rf"\bSMS (ALERT )?{_CHARGE}",
    rf"\b(DEBIT CARD|DC|ATM CARD|ATM) (ANNUAL |AMC |ISSUANCE |RENEWAL |REPLACEMENT |TXN |TRANSACTION |WDL )?{_CHARGE}",
    rf"\b(MIN(IMUM)? (AVG |AVERAGE )?BAL(ANCE)?|NON MAINT(ENANCE)?|AMB|QAB|MAB) {_CHARGE}",
    rf"\b(NEFT|RTGS|IMPS) (COMM(ISSION)?|{_CHARGE})",
    rf"\b(CHQ|CHEQUE) BOOK (ISSUE )?{_CHARGE}",
    rf"\b(ECS|NACH|ACH|CHQ|CHEQUE|SI) (RTN|RETURN|BOUNCE|DISHONOU?R) {_CHARGE}",
    rf"\b(ACCOUNT|AC|A C) (KEEPING|MAINTENANCE|CLOSURE) {_CHARGE}",
    rf"\bCASH (HANDLING|DEP(OSIT)?|TXN|TRANSACTION) {_CHARGE}",
    rf"\bBANK (SERVICE )?{_CHARGE}",
    rf"\bSTOP PAYMENT {_CHARGE}",
    rf"\bLOCKER (RENT|{_CHARGE})",
    # GST on a bank charge, e.g. "GST ON SMS CHARGES" or a bare "GST ON CHARGES".
    rf"\b(C|S|I)?GST ON (SMS|ATM|DEBIT CARD|DC|MIN BAL|AMB|NEFT|RTGS|IMPS|CHQ|CHEQUE|ECS|NACH|BANK|A C|AC)\b",
    rf"^(C|S|I)?GST ON {_CHARGE}",
    # Charge code first, e.g. "CHRG SMS ALERT".
    rf"^{_CHARGE} (FOR )?(SMS|ATM|DEBIT CARD|DC|MIN|AMB|NEFT|RTGS|IMPS|CHQ|CHEQUE|ECS|NACH|ACCOUNT|AC|CASH)\b",
)

_INVESTMENT_PROVIDERS = (
    r"\bMUTUAL FUNDS?\b",
    r"\bBSE STAR MF\b",
    r"\bMF UTIL(ITY|ITIES)?\b",
    r"\bMF (SIP|PURCHASE|PURCH|REDEMPTION|REDEEM|SWITCH|INVESTMENT)\b",
    r"\b(SIP|PURCHASE|PURCH|REDEMPTION|REDEEM) (IN |OF )?MF\b",
    r"\bCAMS\b",
    r"\bKFIN",
    r"\bZERODHA\b",
    r"\bGROWW\b",
    r"\bUPSTOX\b",
    r"\b(ICICI|HDFC|KOTAK|AXIS) ?(SEC|SECURITIES)\b",
    r"\bINDIAN CLEARING CORP",
    r"\bNSE CLEARING\b",
    r"\bBSE LTD\b",
)

_SIP = (
    r"\b(N?ACH|ECS|SI)\b.*\bSIP\b",
    r"\bSIP (INSTAL|INST|PURCHASE|DEBIT|DR)",
)

_NOT_A_TAX_CONCLUSION = (
    "The category reflects the instrument type only; eligibility for any "
    "deduction must be confirmed by the CA from supporting documents."
)

DEFAULT_BANK_RULES: tuple[KeywordRule, ...] = (
    KeywordRule(
        name="bank.deposit_interest",
        category=Category.INTEREST_DEPOSITS,
        direction=Direction.CREDIT,
        patterns=(
            r"\b(FD|RD|TD|FIXED DEPOSIT|RECURRING DEPOSIT|TERM DEPOSIT) INT",
            r"\bINT(EREST)? (ON )?(FD|RD|TD)\b",
        ),
        exclude=_PARTY_TRANSFER,
        confidence=Confidence.HIGH,
        note="Interest on a deposit credited by the bank.",
    ),
    KeywordRule(
        name="bank.savings_interest",
        category=Category.INTEREST_SAVINGS,
        direction=Direction.CREDIT,
        patterns=(
            r"\bSB INT",
            r"\bSAVINGS? (BANK |AC |ACCOUNT )?INT",
            r"\bINT(EREST)? (PD|PAID|CR|CREDIT)\b",
        ),
        exclude=(r"\b(FD|RD|TD|FIXED|RECURRING|TERM)\b", *_PARTY_TRANSFER),
        confidence=Confidence.HIGH,
        note="Savings account interest credited by the bank.",
    ),
    KeywordRule(
        name="bank.tds",
        category=Category.TAX_PAYMENTS,
        direction=Direction.DEBIT,
        patterns=(
            r"\bTDS (ON |DEDUCTED |RECOVERED )?(FD|RD|TD|INT|INTEREST|DEPOSIT)\b",
            r"\b(INT|INTEREST|FD|RD|TD) TDS\b",
            r"\bTDS (DEDUCTED|RECOVERED|DEDN)\b",
        ),
        exclude=_PARTY_TRANSFER,
        confidence=Confidence.MEDIUM,
        note="TDS deducted by the bank; verify against Form 26AS / AIS.",
    ),
    KeywordRule(
        name="bank.charges",
        category=Category.BANK_CHARGES,
        direction=Direction.DEBIT,
        patterns=_BANK_CHARGE_PATTERNS,
        exclude=(r"\bREV(ERSAL|ERSED)?\b", r"\bREFUND\b", *_PARTY_TRANSFER),
        confidence=Confidence.HIGH,
        note="Bank charge or GST on bank charges.",
    ),
    KeywordRule(
        name="bank.reversal_refund",
        category=Category.REVERSALS_REFUNDS,
        direction=Direction.CREDIT,
        patterns=(
            r"\bREVERSAL\b",
            r"\bREVERSED\b",
            rf"\bREV (OF )?{_CHARGE}",
            rf"\b{_CHARGE} REV\b",
            r"\bREFUND\b",
            r"\bCASHBACK\b",
        ),
        exclude=_TAX_DEPARTMENT_ANY,
        confidence=Confidence.MEDIUM,
        note="Reversal or refund credit.",
    ),
)

DEFAULT_SOURCE_RULES: tuple[KeywordRule, ...] = (
    KeywordRule(
        name="source.income_tax_refund",
        category=Category.INCOME_TAX_REFUND,
        direction=Direction.CREDIT,
        patterns=_TAX_REFUND,
        confidence=Confidence.HIGH,
        note="Credit from the income tax department.",
    ),
    KeywordRule(
        name="source.tax_payment",
        category=Category.TAX_PAYMENTS,
        direction=Direction.DEBIT,
        patterns=(
            r"\bCBDT\b",
            r"\bITNS ?28[01]\b",
            r"\bADVANCE TAX\b",
            r"\bSELF ASSESSMENT TAX\b",
            r"\bINCOME ?TAX\b",
            r"\bTIN NSDL\b",
        ),
        confidence=Confidence.HIGH,
        note="Payment to the income tax department.",
    ),
    KeywordRule(
        name="source.salary_keyword",
        category=Category.SALARY_PENSION,
        direction=Direction.CREDIT,
        patterns=(
            r"\bSALARY\b",
            r"\bPENSION\b",
            # "SAL" only with salary context, e.g. "SAL CR", "SAL FOR APR".
            r"\bSAL (CR|CREDIT|PAY|PAYMENT|FOR|OF|AMT|ADV)\b",
            r"\bSAL (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)",
            r"\b(MONTHLY|MTH|MONTH) SAL\b",
        ),
        confidence=Confidence.MEDIUM,
        review_status=ReviewStatus.NEEDS_CONFIRMATION,
        note="Narration mentions salary or pension, but the payer is not a "
        "listed employer; confirm the source.",
    ),
    KeywordRule(
        name="source.health_insurance",
        category=Category.INSURANCE_HEALTH,
        direction=Direction.DEBIT,
        patterns=(
            r"\bHEALTH INS",
            r"\bMEDICLAIM\b",
            r"\bSTAR HEALTH\b",
            r"\bNIVA BUPA\b",
            r"\bCARE HEALTH\b",
        ),
        confidence=Confidence.MEDIUM,
        note="Payment to a health insurer. Policy details must be confirmed "
        "from the policy document.",
    ),
    KeywordRule(
        name="source.tax_saving_instrument",
        category=Category.INVESTMENTS_TAX_SAVING,
        direction=Direction.DEBIT,
        patterns=(
            r"\bPPF\b",
            r"\bNPS\b",
            r"\bELSS\b",
            r"\bSUKANYA\b",
            r"\bSSY (A C|AC|ACCOUNT|DEP|DEPOSIT)\b",
        ),
        confidence=Confidence.MEDIUM,
        review_status=ReviewStatus.NEEDS_REVIEW,
        note="Payment to a PPF/NPS/ELSS-type instrument. " + _NOT_A_TAX_CONCLUSION,
    ),
    KeywordRule(
        name="source.dividend",
        category=Category.DIVIDEND,
        direction=Direction.CREDIT,
        patterns=(
            r"\bDIVIDEND\b",
            r"\b(N?ACH|ECS)\b.*\bDIV\b",
            r"\bDIV (CR|CREDIT|PAYOUT|PAY|WARRANT)\b",
            r"\b(FINAL|INTERIM|INT) DIV\b",
        ),
        confidence=Confidence.HIGH,
        note="Dividend credit.",
    ),
    KeywordRule(
        name="source.investment_redemption",
        category=Category.INVESTMENT_REDEMPTION,
        direction=Direction.CREDIT,
        patterns=_INVESTMENT_PROVIDERS + (r"\bREDEMPTION\b", r"\bREDEEM"),
        confidence=Confidence.MEDIUM,
        note="Credit from a mutual fund provider or broker.",
    ),
    KeywordRule(
        name="source.investment_purchase",
        category=Category.INVESTMENTS_OTHERS,
        direction=Direction.DEBIT,
        patterns=_INVESTMENT_PROVIDERS + _SIP,
        confidence=Confidence.MEDIUM,
        review_status=ReviewStatus.NEEDS_REVIEW,
        note="Payment to a mutual fund provider or broker. The scheme type "
        "(for example ELSS) cannot be determined from the narration.",
    ),
    KeywordRule(
        name="source.loan_emi",
        category=Category.LOAN_EMI,
        direction=Direction.DEBIT,
        patterns=(
            # "EMI" only with loan or mandate context, never alone.
            r"\b(LOAN|LN) ?EMI\b",
            r"\bEMI (FOR|OF|NO|PAYMENT|PYMT|DEBIT|DR|COLLECTION|AMT)\b",
            r"\bEMI \d{3,}",
            r"\b(N?ACH|ECS|SI)\b.*\bEMI\b",
            r"\bLOAN (REPAY|INSTAL|EMI)",
            r"\b(HOME|PERSONAL|CAR|VEHICLE|EDUCATION) LOAN\b",
        ),
        confidence=Confidence.MEDIUM,
        note="Loan instalment.",
    ),
    KeywordRule(
        name="source.loan_disbursal",
        category=Category.LOANS_RECEIVED,
        direction=Direction.CREDIT,
        patterns=(r"\bLOAN DISB", r"\bDISBURS"),
        confidence=Confidence.MEDIUM,
        review_status=ReviewStatus.NEEDS_CONFIRMATION,
        note="Loan disbursal credit; confirm the lender.",
    ),
    KeywordRule(
        name="source.credit_card_payment",
        category=Category.CREDIT_CARD_PAYMENTS,
        direction=Direction.DEBIT,
        patterns=(r"\bCREDIT CARD\b", r"\bCC (PAYMENT|PYMT|BILL)\b", r"\bCARD (BILL|PAYMENT)\b"),
        confidence=Confidence.MEDIUM,
        note="Credit card bill payment.",
    ),
    KeywordRule(
        name="source.cash_withdrawal",
        category=Category.CASH_WITHDRAWAL,
        direction=Direction.DEBIT,
        patterns=(r"\bATM\b", r"\bATW\b", r"\bNWD\b", r"\bCASH (WDL|WITHDRAWAL)\b"),
        exclude=_PARTY_TRANSFER,
        confidence=Confidence.HIGH,
        note="Cash withdrawal.",
    ),
    KeywordRule(
        name="source.cash_deposit",
        category=Category.CASH_DEPOSIT,
        direction=Direction.CREDIT,
        patterns=(r"\bCASH DEP", r"\bBY CASH\b", r"\bCDM\b"),
        confidence=Confidence.HIGH,
        note="Cash deposit.",
    ),
)
