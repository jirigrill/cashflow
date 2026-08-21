# Cashflow

A personal cashflow visualiser over a private Google Spreadsheet, one tab per year.
This glossary fixes the vocabulary the app, its charts, and its docs use.

## Language

### The data

**Tab**:
One year of data — a worksheet named `cashflow YYYY` in the source spreadsheet.
_Avoid_: sheet, worksheet

**Entry**:
One amount for one Category in one month — a single row of a Tab. The smallest unit the
app reads.
_Avoid_: row, line item, transaction

**Category**:
A recurring money flow, identified by the text of its source label. Categories are
whatever the spreadsheet says they are — the app defines no canonical set above them.
_Avoid_: item, line item, label

**Source label**:
The raw text in a tab's `item` column, before normalisation. The thing a Category's
identity is derived from.

**Category identity**:
A Category's source label, trimmed of leading and trailing whitespace, with internal
whitespace runs collapsed to one space, compared case-insensitively. Two rows belong to
the same Category exactly when their normalised labels match. No synonyms and no
renaming are applied.

**Display name**:
The casing a Category is shown in — the first-seen spelling of its label, in tab order.

**Absent**:
A month in which a Category has no Entry. Absent is not zero: series break rather than
drop to the axis, and averages divide by the months a Category is present.

**Dev-mode export**:
A `data/*.csv` file — a manual CSV export of one Tab, used as a development source only.
An export is a **snapshot and goes stale**: it may disagree with the Tab it came from, and
where they disagree the Tab wins. Never a second source of truth, and never evidence about
the data.
_Avoid_: fixture, local data, the CSVs (when the Tab is what is meant)

**Data issue**:
Something the app detects and reports rather than corrects — a sign anomaly, a stale
roll-up, an unparseable cell. Data issues are grouped **by month**: one entry per affected
month, listing every finding within it, so a single underlying mistake that trips two
detectors reads as one problem rather than two.
_Avoid_: error, warning, anomaly (that is one kind of Data issue)

### Classes

**Class**:
The kind of money flow a Category represents. Every Category has exactly one: Income,
Spend, Investments, or Asset sales.
_Avoid_: group, bucket, kind, type

**Income**:
Money earned. Salary and rent received — not money returned from the portfolio, which is
Asset sales.
_Avoid_: operating income, outcome's opposite

**Spend**:
Money spent on living, tax included. Tax carries no special treatment: it is Spend in the
month it lands.
_Avoid_: outcome, expenses, costs, operating spend

**Investments**:
Money put into assets — bought and held, including retained BTC.
_Avoid_: investing, investing outflow

**Asset sales**:
Money returned by selling assets. A separate Class from Income because it is the portfolio
being drawn down, not something earned, and its gross figure dwarfs everything else
(2024: 6.14M sold against 1.49M earned).
_Avoid_: sold shares (that is a Category), investing inflow, disposals

### Measures

**Everyday balance**:
Income plus Spend. Excludes Investments and Asset sales, so it answers whether earnings
cover living costs. Negative in every year so far — the name is deliberately neutral
about sign.
_Avoid_: net income, operating cashflow, profit, surplus

**Net cashflow**:
All four Classes summed — the change in money held over a period. Ties to the source
spreadsheet's own `actual income - outcome` roll-up.
_Avoid_: total, bottom line

**Selection**:
A set of Categories the user has ticked in a chart legend. The app shows their summed
figure for the selected timeframe. A Selection is transient — it is never stored and
never becomes a Category of its own.

### Checks

Two checks, against two different kinds of truth. Roll-up check asks whether the app's
arithmetic matches the spreadsheet's own arithmetic; Reconciliation asks whether the
spreadsheet matches the bank. They are never collapsed into one word: they have different
subjects, different failure meanings, and one of them is unavailable in dev mode.

**Recomputation**:
Deriving every displayed figure from Entries alone. The app always recomputes; a Tab's
roll-up columns are never a source, only a subject of the Roll-up check.

**Roll-up column**:
A figure the source spreadsheet computes for itself — `forecast vs actual` and
`actual income - outcome`, carried on the final Entry of each monthly block and again as
a Tab-level total. Not an input to any Measure.

**Roll-up check**:
The check that Recomputation agrees with each Roll-up column — per month, per column, and
per Tab total independently. Exact integer equality; there is no tolerance. A failure means
the spreadsheet's stored figure is stale, never that the app's arithmetic is wrong.
_Avoid_: reconciliation (that is the bank check), validation

**Stale roll-up**:
A Roll-up column whose value no longer matches the Entries above it, because a cell was
edited after the spreadsheet last evaluated its formulas. The failure mode Roll-up check
exists to catch.

**Opening balance**:
Money held before the first Entry — the `starting amount` row. Not a cashflow: it is
excluded from every Class and every Measure, and serves only as the starting point for
Reconciliation.
_Avoid_: starting amount (that is the source label), excluded, initial balance

**Bank balance**:
The real balance of an account (Air Bank, Revolut) as recorded in a Tab's footer. Stated,
not derived — a hand-entered snapshot of the account, so it is evidence about the world
rather than a figure the spreadsheet computes. **Not necessarily comparable across Tabs**:
one Tab may state a plain cash figure where another states a foreign-currency position
valued at hand-entered exchange rates.

**Reconciliation**:
The check that Opening balance plus Net cashflow, less any Accepted gap, equals the Bank
balance. A mismatch means Entries and the real account disagree — money moved without being
recorded — and it does not mean a Class is wrong. Unlike Roll-up check, a mismatch is not
necessarily fixable: the Entries may simply be incomplete for a year that was never fully
tracked.
_Avoid_: checkpoint, validation, audit, roll-up check

**Accepted gap**:
A stated, hand-entered figure on a Tab naming a Reconciliation difference the owner has
decided not to chase. Per Tab, because Reconciliation is per Tab. Recorded in the source
spreadsheet like any other datum — the app reads it and never writes it. Absent means zero:
a Tab with no Accepted gap must tie exactly.
_Avoid_: baseline, tolerance, threshold, fudge, adjustment

**Residual**:
What Reconciliation actually tests — the difference remaining after the Accepted gap is
applied. Zero residual is a pass, whatever the Accepted gap's size, so the check reports
new divergence rather than known history.

**Reconciliation state**:
One of three, ranked worst-first for display: **doesn't tie** (non-zero Residual),
**ties** (zero Residual — noted as baselined when an Accepted gap was applied), and
**can't be evaluated** (the Tab states no closing Bank balance). The third is neutral, not
a warning: an in-progress year has no closing balance and should not have one. The state
depends on the Tab, never on the source the data came from — a Tab reconciles identically
from the spreadsheet or from a Dev-mode export.
