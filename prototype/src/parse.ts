import Papa from 'papaparse';
import type { BankBalance, DataIssue, Entry, RollupRow, Tab } from './domain.ts';
import { OPENING_LABEL, classify, isKnownLabel, normaliseLabel } from './classify.ts';

/**
 * Strip presentation-only separators before the strict numeric test. NBSP
 * (U+00A0) and narrow NBSP (U+202F) carry the Sheet's thousands separators on
 * the footer and tab-total cells; a parser that misses them silently drops
 * those cells from the Roll-up check.
 */
function stripSeparators(raw: string): string {
  return raw.replace(/[   \s]/g, '');
}

/**
 * Strict: an empty cell is null, anything else must parse cleanly. Junk is a
 * Data issue, never zero — coercing it is what manufactured a phantom million.
 */
export function parseNumber(raw: string | undefined): { value: number | null; bad: boolean } {
  if (raw === undefined) return { value: null, bad: false };
  const cleaned = stripSeparators(raw);
  if (cleaned === '') return { value: null, bad: false };
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { value: null, bad: true };
  return { value: Number(cleaned), bad: false };
}

/** `2023-04` → 4. Footers hold dates like `1.1.2025`, which are not blocks. */
function monthFromCell(cell: string): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(cell.trim());
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? month : null;
}

function yearFromFilename(name: string): number | null {
  const m = /cashflow\s+(\d{4})/i.exec(name);
  return m ? Number(m[1]) : null;
}

/** The footer marker — `air bank` header row, or the Czech `stav uctu` labels. */
function isBalanceMarker(cell: string): boolean {
  const c = normaliseLabel(cell);
  return c.includes('air bank') || c.includes('stav uctu') || c.includes('revolut');
}

export function parseTab(filename: string, csv: string): Tab {
  const year = yearFromFilename(filename);
  if (year === null) throw new Error(`cannot derive year from ${filename}`);

  const parsed = Papa.parse<string[]>(csv.replace(/^﻿/, ''), {
    skipEmptyLines: false,
  });
  const rows = parsed.data;

  const entries: Entry[] = [];
  const rollups: RollupRow[] = [];
  const parseIssues: DataIssue[] = [];
  const displayNames = new Map<string, string>();
  let openingAmount: number | null = null;
  let tabTotals: Tab['tabTotals'] = null;
  let openingBalance: BankBalance | null = null;
  let closingBalance: BankBalance | null = null;

  /**
   * Entries are grouped by *block position*, not by the month column: the
   * misfiled `2023-05 tax` row proves the two can disagree, and both April and
   * May roll-ups tie against their own blocks.
   */
  let currentBlock: number | null = null;
  let pendingRollupRow: RollupRow | null = null;

  const flushBlock = () => {
    if (pendingRollupRow) rollups.push(pendingRollupRow);
    pendingRollupRow = null;
  };

  const balanceRows: { row: string[]; index: number }[] = [];
  let inFooter = false;

  rows.forEach((row, i) => {
    const lineNo = i + 1;
    if (i === 0) return; // header
    const [monthCell = '', itemCell = '', fCell = '', aCell = '', rollupF = '', rollupNet = ''] =
      row.map((c) => c ?? '');

    if (isBalanceMarker(itemCell) || isBalanceMarker(monthCell)) {
      inFooter = true;
      balanceRows.push({ row, index: i });
      return;
    }
    if (inFooter) {
      balanceRows.push({ row, index: i });
      return;
    }

    const blockMonth = monthFromCell(monthCell);
    const hasItem = itemCell.trim() !== '';

    if (blockMonth !== null && hasItem) {
      // A new date starts a new block only when it differs from the current one
      // *and* the previous block has already been closed by its roll-up row.
      if (currentBlock === null) {
        currentBlock = blockMonth;
      } else if (blockMonth !== currentBlock && pendingRollupRow === null) {
        currentBlock = blockMonth;
      }
    }

    if (hasItem && currentBlock !== null) {
      const forecast = parseNumber(fCell);
      const actual = parseNumber(aCell);
      if (forecast.bad) {
        parseIssues.push({
          year,
          blockMonth: currentBlock,
          kind: 'unparseable',
          detail: `row ${lineNo}: forecast "${fCell}" is not a number`,
        });
      }
      if (actual.bad) {
        parseIssues.push({
          year,
          blockMonth: currentBlock,
          kind: 'unparseable',
          detail: `row ${lineNo}: actual "${aCell}" is not a number`,
        });
      }

      const categoryId = normaliseLabel(itemCell);

      if (categoryId === OPENING_LABEL) {
        // Opening balance annotation — excluded from every Class and Measure.
        openingAmount = actual.value;
      } else {
        if (!displayNames.has(categoryId)) displayNames.set(categoryId, itemCell.trim());
        const misfiled = blockMonth !== null && blockMonth !== currentBlock;
        if (misfiled) {
          parseIssues.push({
            year,
            blockMonth: currentBlock,
            kind: 'misfiled-date',
            detail: `row ${lineNo}: "${itemCell.trim()}" is dated ${monthCell.trim()} but sits in the ${String(
              currentBlock,
            ).padStart(2, '0')} block`,
          });
        }
        if (!isKnownLabel(categoryId)) {
          parseIssues.push({
            year,
            blockMonth: currentBlock,
            kind: 'unknown-label',
            detail: `row ${lineNo}: "${itemCell.trim()}" is not in the class table — classified by sign`,
          });
        }
        entries.push({
          year,
          blockMonth: currentBlock,
          rawMonth: monthCell.trim(),
          sourceLabel: itemCell.trim(),
          categoryId,
          displayName: displayNames.get(categoryId)!,
          forecast: forecast.value,
          actual: actual.value,
          cls: classify(categoryId, actual.value),
          misfiled,
          sourceRow: lineNo,
        });
      }

      // The final Entry of a block carries the two roll-up columns.
      const rf = parseNumber(rollupF);
      const rn = parseNumber(rollupNet);
      if (rf.value !== null || rn.value !== null) {
        pendingRollupRow = {
          year,
          blockMonth: currentBlock,
          sheetForecastVsActual: rf.value,
          sheetNet: rn.value,
        };
        flushBlock();
      }
      return;
    }

    // A row with no item but roll-up figures is the Tab-level total.
    if (!hasItem) {
      const rf = parseNumber(rollupF);
      const rn = parseNumber(rollupNet);
      if (rf.value !== null || rn.value !== null) {
        tabTotals = { forecastVsActual: rf.value, net: rn.value };
      }
    }
  });
  flushBlock();

  // Footer layout differs on all four tabs, so locate by marker rather than by
  // a fixed offset. Two shapes: Czech label/value rows (2024), or a header row
  // followed by dated opening/closing rows (2025, 2026).
  const czech: BankBalance[] = [];
  for (const { row } of balanceRows) {
    const label = (row[0] ?? '').trim();
    const item = (row[1] ?? '').trim();
    const lower = normaliseLabel(label);

    if (lower.includes('stav uctu')) {
      const v = parseNumber(row[1]);
      const which = lower.includes('revolut') ? 'revolut' : 'air bank';
      const existing = czech[0];
      const target = existing ?? { label: label.replace(/\s+/g, ' '), airBank: null, revolut: null, total: null };
      if (which === 'revolut') target.revolut = v.value;
      else target.airBank = v.value;
      if (!existing) czech.push(target);
      continue;
    }

    // Header row: `,air bank,revolut,,,` — skip, it names the columns.
    if (normaliseLabel(item) === 'air bank') continue;

    if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(label)) {
      const air = parseNumber(row[1]);
      const rev = parseNumber(row[2]);
      const total = parseNumber(row[3]);
      const bal: BankBalance = {
        label,
        airBank: air.value,
        revolut: rev.value,
        total: total.value ?? (air.value !== null && rev.value !== null ? air.value + rev.value : null),
      };
      if (openingBalance === null) openingBalance = bal;
      else closingBalance = bal;
    }
  }
  if (openingBalance === null && czech.length > 0) {
    const c = czech[0];
    openingBalance = {
      ...c,
      total: c.airBank !== null && c.revolut !== null ? c.airBank + c.revolut : null,
    };
  }
  // A closing row with both ends empty (2026 in progress) is not a balance.
  if (closingBalance && closingBalance.airBank === null && closingBalance.revolut === null) {
    closingBalance = null;
  }

  return {
    year,
    entries,
    rollups,
    tabTotals,
    openingBalance,
    closingBalance,
    openingAmount,
    parseIssues,
  };
}

export async function loadTabs(): Promise<Tab[]> {
  const files: string[] = await fetch('/data/index.json').then((r) => r.json());
  const tabs = await Promise.all(
    files.map(async (f) => parseTab(f, await fetch(`/data/${encodeURIComponent(f)}`).then((r) => r.text()))),
  );
  return tabs.sort((a, b) => a.year - b.year);
}
