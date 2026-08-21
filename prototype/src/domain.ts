/**
 * Domain vocabulary — mirrors CONTEXT.md. Kept deliberately thin: this is a
 * throwaway prototype, so nothing here is meant to survive into the real app.
 */

export type Class = 'Income' | 'Spend' | 'Investments' | 'Asset sales';

/** One amount for one Category in one month — a single row of a Tab. */
export interface Entry {
  /** Year of the Tab this Entry came from. */
  year: number;
  /** Month 1–12, derived from the *block* the Entry sits in, not its date cell. */
  blockMonth: number;
  /** Verbatim contents of the `month` column, for the raw-row drawer. */
  rawMonth: string;
  /** Verbatim `item` text. */
  sourceLabel: string;
  /** Normalised identity: trimmed, whitespace collapsed, lower-cased. */
  categoryId: string;
  /** First-seen casing, for display. */
  displayName: string;
  forecast: number | null;
  actual: number | null;
  cls: Class;
  /** Set when this Entry's date cell disagrees with its block. */
  misfiled: boolean;
  /** 1-based line number in the CSV, so the drawer can point at the source. */
  sourceRow: number;
}

export interface RollupRow {
  year: number;
  blockMonth: number;
  /** The Tab's own `forecast vs actual` figure for this block. */
  sheetForecastVsActual: number | null;
  /** The Tab's own `actual income - outcome` figure for this block. */
  sheetNet: number | null;
}

export interface BankBalance {
  /** Verbatim date cell (`1.1.2025`). */
  label: string;
  airBank: number | null;
  revolut: number | null;
  total: number | null;
}

export interface Tab {
  year: number;
  entries: Entry[];
  rollups: RollupRow[];
  /** Tab-level totals row, when present. */
  tabTotals: { forecastVsActual: number | null; net: number | null } | null;
  openingBalance: BankBalance | null;
  closingBalance: BankBalance | null;
  /** The `starting amount` Entry, excluded from every Measure. */
  openingAmount: number | null;
  /** Parse-level problems: unparseable cells, misfiled dates. */
  parseIssues: DataIssue[];
}

export type IssueKind =
  | 'sign-anomaly'
  | 'stale-rollup'
  | 'stale-tab-total'
  | 'unparseable'
  | 'misfiled-date'
  | 'unreported-month'
  | 'unknown-label';

export interface DataIssue {
  year: number;
  /** null for Tab-level findings that belong to no single month. */
  blockMonth: number | null;
  kind: IssueKind;
  detail: string;
}

export interface MonthKey {
  year: number;
  month: number;
}
