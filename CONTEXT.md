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

### Reconciliation

**Opening balance**:
Money held before the first Entry — the `starting amount` row. Not a cashflow: it is
excluded from every Class and every Measure, and serves only as the starting point for
reconciliation.
_Avoid_: starting amount (that is the source label), excluded, initial balance

**Bank balance**:
The real balance of an account (Air Bank, Revolut) as recorded in a Tab's footer. Stated,
not derived.

**Reconciliation**:
The check that Opening balance plus Net cashflow equals the Bank balance. A mismatch means
the data is wrong, never that a Class is wrong.
_Avoid_: checkpoint, validation, audit
