# Cashflow

A personal cashflow visualiser over a private Google Spreadsheet, one tab per year.
This glossary fixes the vocabulary the app, its charts, and its docs use.

## Language

**Category**:
One income or spending line, identified by the text of its source label. Categories are
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

**Selection**:
A set of Categories the user has ticked in a chart legend. The app shows their summed
figure for the selected timeframe. A Selection is transient — it is never stored and
never becomes a Category of its own.

**Absent**:
A month in which a Category has no row. Absent is not zero: series break rather than
drop to the axis, and averages divide by the months a Category is present.

**Tab**:
One year of data — a worksheet named `cashflow YYYY` in the source spreadsheet.
_Avoid_: sheet, worksheet
