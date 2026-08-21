/**
 * Verification harness — checks the prototype's parser and aggregation against
 * the figures the map already records, so a wrong prototype cannot be mistaken
 * for a design verdict. Run: npm run verify
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseTab } from './src/parse.ts';
import {
  rollupCheck,
  reconciliation,
  collectIssues,
  netCashflow,
  everydayBalance,
  bucketByMonth,
} from './src/aggregate.ts';

const DATA = resolve('../data');
const files = readdirSync(DATA).filter((f) => f.endsWith('.csv')).sort();
const tabs = files.map((f) => parseTab(f, readFileSync(resolve(DATA, f), 'utf8')));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}${ok ? '' : `, expected ${expected}`}`);
};

console.log('=== tabs parsed ===');
for (const t of tabs) {
  console.log(
    `${t.year}: ${t.entries.length} entries, ${t.rollups.length} monthly roll-ups, ` +
      `tab total ${t.tabTotals ? `${t.tabTotals.forecastVsActual}/${t.tabTotals.net}` : 'none'}, ` +
      `opening ${t.openingBalance?.total ?? '—'}, closing ${t.closingBalance?.total ?? '—'}`,
  );
}

console.log('\n=== measures vs the map ===');
// The map's Cashflow-classification table, adjusted to the four-class model:
// everyday balance = Income + Spend.
//
// 2025 is 4,490 off that table — because the table was computed *before*
// 2025-07's stale roll-up cleared itself. The figures below are the current
// ones, and 2025's net ties exactly to the tab total the Sheet carries
// (285,967), so the table is what is stale, not the parse.
const expectedEveryday = { 2023: -20483, 2024: -190015, 2025: -123962, 2026: -104561 };
const expectedNet = { 2023: 548994, 2024: -90919, 2025: 285967, 2026: -80380 };
for (const t of tabs) {
  check(`${t.year} everyday balance`, Math.round(everydayBalance(t.entries)), expectedEveryday[t.year]);
  check(`${t.year} net cashflow`, Math.round(netCashflow(t.entries)), expectedNet[t.year]);
}

console.log('\n=== roll-up check ===');
for (const t of tabs) {
  const results = rollupCheck(t);
  const bad = results.filter((r) => !r.ok);
  console.log(
    `${t.year}: ${results.length} comparisons, ${bad.length} failing` +
      bad.map((b) => `\n    ${b.month ?? 'tab total'} ${b.column}: sheet ${b.sheet} vs recomputed ${b.recomputed}`).join(''),
  );
}
// The map says the only surviving roll-up finding across all four years is
// 2026's tab total, stale by +3,400.
const allBad = tabs.flatMap(rollupCheck).filter((r) => !r.ok);
check('total failing roll-up comparisons', allBad.length, 1);
if (allBad.length === 1) {
  check('the failure is 2026', allBad[0].year, 2026);
  check('it is a tab total', allBad[0].month, null);
  check('stale by +3400', allBad[0].sheet - allBad[0].recomputed, 3400);
}

console.log('\n=== reconciliation ===');
for (const t of tabs) {
  const r = reconciliation(t);
  console.log(
    `${t.year}: ${r.state}${r.state === 'absent' ? ` (${r.reason})` : ` — opening ${r.opening}, net ${r.net}, expected ${r.expected}, actual ${r.actual}, gap ${r.gap}`}`,
  );
}
// Only 2025 has both ends, and it does not tie — off by 243,050.
const recon2025 = reconciliation(tabs.find((t) => t.year === 2025));
check('2025 reconciliation state', recon2025.state, 'fail');
check('2025 gap', recon2025.gap, 243050);
for (const y of [2023, 2024, 2026]) {
  check(`${y} reconciliation absent`, reconciliation(tabs.find((t) => t.year === y)).state, 'absent');
}

console.log('\n=== sign anomalies ===');
const issues = collectIssues(tabs);
const signs = issues.flatMap((m) => m.issues.filter((i) => i.kind === 'sign-anomaly').map((i) => `${m.key}: ${i.detail}`));
signs.forEach((s) => console.log(`  ${s}`));
check('sign anomalies found', signs.length, 3);

console.log('\n=== misfiled dates ===');
const misfiled = issues.flatMap((m) =>
  m.issues.filter((i) => i.kind === 'misfiled-date').map((i) => `${m.key}: ${i.detail}`),
);
misfiled.forEach((s) => console.log(`  ${s}`));
// The map records exactly one misfiled row — `2023-05 tax` sitting inside the
// April block — and uses it to justify block-based rather than date-based
// grouping. It does **not** reproduce in the current export: the tax row is at
// line 54, inside the May block (lines 51–63), and dated 2023-05, which agrees.
// Every row in all four tabs agrees with its block, so date-based grouping would
// currently produce identical figures and the constraint has no live test case.
check('misfiled rows found', misfiled.length, 0);

// Which means the constraint is untestable against today's data — recorded so
// that "the roll-ups tie" is not mistaken for "block grouping is proven".
console.log(
  '  note: no row disagrees with its block in any tab, so block-based and\n' +
    '  date-based grouping are currently indistinguishable. Block-based is kept\n' +
    '  because it is the locked decision and degrades safely, not because this\n' +
    '  data proves it.',
);

console.log('\n=== unreported months ===');
const unreported = issues.flatMap((m) => m.issues.filter((i) => i.kind === 'unreported-month').map(() => m.key));
console.log(`  ${unreported.join(', ')}`);
check('unreported months', unreported.length, 5);

console.log('\n=== unparseable cells ===');
const junk = issues.flatMap((m) => m.issues.filter((i) => i.kind === 'unparseable').map((i) => `${m.key}: ${i.detail}`));
junk.forEach((s) => console.log(`  ${s}`));
check('unparseable cells', junk.length, 0);

console.log('\n=== block grouping sanity ===');
for (const t of tabs) {
  const buckets = bucketByMonth(t.entries);
  check(`${t.year} has 12 monthly blocks`, buckets.length, 12);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
