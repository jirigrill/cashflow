import type { Tab } from './domain.ts';
import {
  fmtCZK,
  everydayBalance,
  netCashflow,
  reconciliation,
  rollupCheck,
  type MonthIssues,
} from './aggregate.ts';

/**
 * The numbers strip — the routine-glance answer, at the top of the page.
 * Prototype position: everyday balance, net cashflow, reconciliation ✓/✗,
 * ~120px tall.
 *
 * The reconciliation cell reads the **current** check every render. A ✗ can
 * clear with no user action (2025-07's stale roll-up did exactly that), so the
 * strip must never show a remembered verdict.
 */
export function renderStrip(
  selectedTabs: Tab[],
  issues: MonthIssues[],
  onIssuesClick: () => void,
): HTMLElement {
  const entries = selectedTabs.flatMap((t) => t.entries);
  const everyday = Math.round(everydayBalance(entries));
  const net = Math.round(netCashflow(entries));

  const el = document.createElement('section');
  el.className = 'strip';

  el.append(
    cell('Everyday balance', fmtCZK(everyday), everyday, 'income + spend, tax included'),
    cell('Net cashflow', fmtCZK(net), net, 'all four classes'),
    reconCell(selectedTabs),
    issuesCell(selectedTabs, issues, onIssuesClick),
  );
  return el;
}

function cell(k: string, v: string, sign: number, sub: string): HTMLElement {
  const d = document.createElement('div');
  const kk = document.createElement('div');
  kk.className = 'k';
  kk.textContent = k;
  const vv = document.createElement('div');
  vv.className = `v ${sign < 0 ? 'neg' : 'pos'}`;
  vv.textContent = v;
  const ss = document.createElement('div');
  ss.className = 'sub';
  ss.textContent = sub;
  d.append(kk, vv, ss);
  return d;
}

function reconCell(tabs: Tab[]): HTMLElement {
  const d = document.createElement('div');
  const kk = document.createElement('div');
  kk.className = 'k';
  kk.textContent = 'Reconciliation';

  const results = tabs.map(reconciliation);
  const runnable = results.filter((r) => r.state !== 'absent');
  const failed = runnable.filter((r) => r.state === 'fail');

  const vv = document.createElement('div');
  vv.className = 'v';
  const ss = document.createElement('div');
  ss.className = 'sub';

  if (runnable.length === 0) {
    vv.textContent = '—';
    vv.style.color = 'var(--ink-dim)';
    ss.textContent = `absent for ${tabs.map((t) => t.year).join(', ')} — ${
      results[0]?.reason ?? 'no bank balances'
    }`;
  } else if (failed.length === 0) {
    vv.textContent = '✓';
    vv.style.color = 'var(--good)';
    ss.textContent = `ties for ${runnable.map((r) => r.year).join(', ')}`;
  } else {
    vv.textContent = '✗';
    vv.style.color = 'var(--bad)';
    ss.textContent = failed
      .map((r) => `${r.year} off by ${fmtCZK(r.gap ?? 0)}`)
      .join('; ');
  }

  // Absent years are shown as absent, never faked.
  const absent = results.filter((r) => r.state === 'absent');
  if (runnable.length > 0 && absent.length > 0) {
    ss.textContent += ` · absent for ${absent.map((r) => r.year).join(', ')}`;
  }

  d.append(kk, vv, ss);
  return d;
}

function issuesCell(tabs: Tab[], issues: MonthIssues[], onClick: () => void): HTMLElement {
  const d = document.createElement('div');
  const kk = document.createElement('div');
  kk.className = 'k';
  kk.textContent = 'Roll-up check';

  const rollups = tabs.flatMap(rollupCheck);
  const bad = rollups.filter((r) => !r.ok);

  const vv = document.createElement('div');
  vv.className = 'v';
  vv.textContent = bad.length === 0 ? '✓' : '✗';
  vv.style.color = bad.length === 0 ? 'var(--good)' : 'var(--bad)';

  const relevant = issues.filter((m) => tabs.some((t) => t.year === m.year));
  const count = relevant.reduce((a, m) => a + m.issues.length, 0);

  const badge = document.createElement('button');
  badge.className = `badge ${count === 0 ? 'good' : 'bad'}`;
  badge.textContent =
    count === 0
      ? 'no data issues'
      : `${count} data issue${count === 1 ? '' : 's'} in ${relevant.length} month${
          relevant.length === 1 ? '' : 's'
        } →`;
  badge.addEventListener('click', onClick);

  d.append(kk, vv, badge);
  return d;
}

/**
 * The data-issues panel. Prototype position: bottom of the page, reached by
 * clicking the badge in the numbers strip. Grouped by month — one entry per
 * affected month listing every finding, so a single underlying mistake that
 * trips two detectors reads as one problem.
 */
export function renderIssuesPanel(tabs: Tab[], issues: MonthIssues[]): HTMLElement {
  const el = document.createElement('section');
  el.className = 'issues';
  el.id = 'data-issues';

  const header = document.createElement('header');
  const h2 = document.createElement('h2');
  h2.textContent = 'Data issues';
  const q = document.createElement('span');
  q.className = 'q';
  q.textContent = 'which numbers can’t I trust — surfaced, never silently corrected';
  header.append(h2, q);
  el.append(header);

  // Persistent one-line status, plus per-month detail below — the two
  // resolutions the checks are meant to surface at.
  const checks = document.createElement('div');
  checks.className = 'checks';
  for (const tab of tabs) {
    const bad = rollupCheck(tab).filter((r) => !r.ok);
    const recon = reconciliation(tab);
    const span = document.createElement('span');
    const reconText =
      recon.state === 'absent'
        ? `reconciliation absent (${recon.reason})`
        : recon.state === 'pass'
          ? 'reconciliation ties'
          : `reconciliation off by ${fmtCZK(recon.gap ?? 0)}`;
    span.innerHTML = `<strong>${tab.year}</strong> — roll-up ${
      bad.length === 0 ? '✓' : `✗ ${bad.length} failing`
    } · ${reconText}`;
    if (recon.state === 'absent') span.classList.add('absent');
    checks.append(span);
  }
  el.append(checks);

  const relevant = issues.filter((m) => tabs.some((t) => t.year === m.year));
  if (relevant.length === 0) {
    const p = document.createElement('div');
    p.className = 'issue-month';
    p.textContent = 'Nothing detected for the selected years.';
    el.append(p);
    return el;
  }

  for (const m of relevant) {
    const div = document.createElement('div');
    div.className = 'issue-month';
    const label = document.createElement('div');
    label.className = 'm';
    label.textContent = m.key;
    const ul = document.createElement('ul');
    for (const i of m.issues) {
      const li = document.createElement('li');
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = i.kind;
      li.append(kind, document.createTextNode(i.detail));
      ul.append(li);
    }
    div.append(label, ul);
    el.append(div);
  }
  return el;
}
