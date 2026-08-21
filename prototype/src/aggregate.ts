import type { Class, DataIssue, Entry, Tab } from './domain.ts';
import { isSignAnomaly } from './classify.ts';

export { EVERYDAY_CLASSES, INVESTING_CLASSES } from './classify.ts';
import { EVERYDAY_CLASSES } from './classify.ts';

export interface MonthBucket {
  year: number;
  month: number;
  /** `2025-07`, used as an axis label and as a bucket key. */
  key: string;
  entries: Entry[];
  /** True when every Entry's actual is 0 — the month has not happened yet. */
  unreported: boolean;
}

export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function bucketByMonth(entries: Entry[]): MonthBucket[] {
  const map = new Map<string, MonthBucket>();
  for (const e of entries) {
    const key = monthKey(e.year, e.blockMonth);
    let b = map.get(key);
    if (!b) {
      b = { year: e.year, month: e.blockMonth, key, entries: [], unreported: false };
      map.set(key, b);
    }
    b.entries.push(e);
  }
  const buckets = [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  // Unreported-month rule: a month whose every Entry has actual 0 is treated as
  // not-yet-happened. Display rule only — the source is untouched.
  for (const b of buckets) {
    b.unreported = b.entries.length > 0 && b.entries.every((e) => (e.actual ?? 0) === 0);
  }
  return buckets;
}

export function sumActual(entries: Entry[], classes: Class[]): number {
  return entries
    .filter((e) => classes.includes(e.cls))
    .reduce((acc, e) => acc + (e.actual ?? 0), 0);
}

export function sumForecast(entries: Entry[], classes: Class[]): number {
  return entries
    .filter((e) => classes.includes(e.cls))
    .reduce((acc, e) => acc + (e.forecast ?? 0), 0);
}

/** Income + Spend — answers whether earnings cover living costs. */
export function everydayBalance(entries: Entry[]): number {
  return sumActual(entries, EVERYDAY_CLASSES);
}

/** All four Classes — the change in money held. */
export function netCashflow(entries: Entry[]): number {
  return entries.reduce((acc, e) => acc + (e.actual ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export interface RollupCheckResult {
  year: number;
  /** null for the Tab-level total. */
  month: number | null;
  column: 'forecast vs actual' | 'actual income - outcome';
  sheet: number;
  recomputed: number;
  ok: boolean;
}

/**
 * The Tab's `forecast vs actual` column is the **variance**: actual net minus
 * forecast net, across every Class. Verified against 2023's tab total
 * (548,994 actual − 336,000 forecast = 212,994, the figure the Tab carries).
 * Reading it as the forecast net instead makes every month fail the check.
 */
function variance(entries: Entry[]): number {
  return Math.round(netCashflow(entries) - sumForecast(entries, ALL_CLASSES));
}

/**
 * Roll-up check: the app's arithmetic against the Sheet's own, per month, per
 * column, and per Tab total independently. Exact integer equality, no
 * tolerance — the live discrepancies are 4,490 / 3,400 / 589, and a threshold
 * would hide them.
 */
export function rollupCheck(tab: Tab): RollupCheckResult[] {
  const results: RollupCheckResult[] = [];
  const buckets = bucketByMonth(tab.entries);
  const byMonth = new Map(buckets.map((b) => [b.month, b]));

  for (const r of tab.rollups) {
    const bucket = byMonth.get(r.blockMonth);
    if (!bucket) continue;
    if (r.sheetForecastVsActual !== null) {
      const recomputed = variance(bucket.entries);
      results.push({
        year: tab.year,
        month: r.blockMonth,
        column: 'forecast vs actual',
        sheet: r.sheetForecastVsActual,
        recomputed,
        ok: recomputed === r.sheetForecastVsActual,
      });
    }
    if (r.sheetNet !== null) {
      const recomputed = Math.round(netCashflow(bucket.entries));
      results.push({
        year: tab.year,
        month: r.blockMonth,
        column: 'actual income - outcome',
        sheet: r.sheetNet,
        recomputed,
        ok: recomputed === r.sheetNet,
      });
    }
  }

  if (tab.tabTotals) {
    const all = tab.entries;
    if (tab.tabTotals.forecastVsActual !== null) {
      const recomputed = variance(all);
      results.push({
        year: tab.year,
        month: null,
        column: 'forecast vs actual',
        sheet: tab.tabTotals.forecastVsActual,
        recomputed,
        ok: recomputed === tab.tabTotals.forecastVsActual,
      });
    }
    if (tab.tabTotals.net !== null) {
      const recomputed = Math.round(netCashflow(all));
      results.push({
        year: tab.year,
        month: null,
        column: 'actual income - outcome',
        sheet: tab.tabTotals.net,
        recomputed,
        ok: recomputed === tab.tabTotals.net,
      });
    }
  }

  return results;
}

export const ALL_CLASSES: Class[] = ['Income', 'Spend', 'Investments', 'Asset sales'];

export type ReconciliationState = 'pass' | 'fail' | 'absent';

export interface ReconciliationResult {
  year: number;
  state: ReconciliationState;
  /** Why it cannot run, when absent. */
  reason?: string;
  opening?: number;
  net?: number;
  expected?: number;
  actual?: number;
  gap?: number;
}

/**
 * Reconciliation: Opening balance + Net cashflow against the Bank balance.
 * Needs both ends, which only 2025 has — so it is *absent* for the other
 * years, shown as absent and never faked.
 */
export function reconciliation(tab: Tab): ReconciliationResult {
  const opening = tab.openingBalance?.total ?? null;
  const closing = tab.closingBalance?.total ?? null;
  if (opening === null) {
    return { year: tab.year, state: 'absent', reason: 'no opening bank balance in this tab' };
  }
  if (closing === null) {
    return { year: tab.year, state: 'absent', reason: 'no closing bank balance in this tab' };
  }
  const net = Math.round(netCashflow(tab.entries));
  const expected = Math.round(opening + net);
  const gap = Math.round(closing - expected);
  return {
    year: tab.year,
    state: gap === 0 ? 'pass' : 'fail',
    opening,
    net,
    expected,
    actual: closing,
    gap,
  };
}

/**
 * Everything the app detects and reports rather than corrects, grouped by
 * month: one entry per affected month listing every finding within it.
 */
export interface MonthIssues {
  key: string;
  year: number;
  /** null for Tab-level findings. */
  month: number | null;
  issues: DataIssue[];
}

export function collectIssues(tabs: Tab[]): MonthIssues[] {
  const all: DataIssue[] = [];

  for (const tab of tabs) {
    all.push(...tab.parseIssues);

    for (const e of tab.entries) {
      if (isSignAnomaly(e.categoryId, e.actual)) {
        all.push({
          year: e.year,
          blockMonth: e.blockMonth,
          kind: 'sign-anomaly',
          detail: `"${e.sourceLabel}" is ${e.cls} but its actual is ${fmtSigned(e.actual)}`,
        });
      }
    }

    for (const r of rollupCheck(tab)) {
      if (r.ok) continue;
      all.push({
        year: r.year,
        blockMonth: r.month,
        kind: r.month === null ? 'stale-tab-total' : 'stale-rollup',
        detail: `${r.column}: the tab says ${fmtSigned(r.sheet)}, the entries sum to ${fmtSigned(
          r.recomputed,
        )} (off by ${fmtSigned(r.sheet - r.recomputed)})`,
      });
    }

    for (const b of bucketByMonth(tab.entries)) {
      if (b.unreported) {
        all.push({
          year: b.year,
          blockMonth: b.month,
          kind: 'unreported-month',
          detail: 'every actual is 0 — treated as not-yet-happened, so the actual series stops here',
        });
      }
    }
  }

  const map = new Map<string, MonthIssues>();
  for (const issue of all) {
    const key = issue.blockMonth === null ? `${issue.year} (tab)` : monthKey(issue.year, issue.blockMonth);
    let m = map.get(key);
    if (!m) {
      m = { key, year: issue.year, month: issue.blockMonth, issues: [] };
      map.set(key, m);
    }
    m.issues.push(issue);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function fmtSigned(n: number | null): string {
  if (n === null) return '—';
  const s = Math.abs(n).toLocaleString('cs-CZ');
  return n < 0 ? `−${s}` : `+${s}`;
}

export function fmtCZK(n: number | null): string {
  if (n === null) return '—';
  return `${n < 0 ? '−' : ''}${Math.abs(Math.round(n)).toLocaleString('cs-CZ')} Kč`;
}

/** 1,234,567 → "1,23 M" for compact axis labels. */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)}k`;
  return `${sign}${abs}`;
}
