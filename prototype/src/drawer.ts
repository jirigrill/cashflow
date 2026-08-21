import type { Entry } from './domain.ts';
import { fmtCZK } from './aggregate.ts';

/**
 * The raw-row drawer: click a bar, see the Entries behind that number. Shows the
 * source columns verbatim plus one derived column naming the Class — verbatim is
 * what catches source errors, the Class column is what catches misclassification.
 *
 * It **replaces** rather than accumulates: the job is "explain *this* number",
 * and accumulation quietly becomes a second, worse table view.
 *
 * Prototype position: opens **inline beneath the clicked chart**. Whether the
 * content pushing down is disorienting is exactly the thing to judge.
 */
export function renderDrawer(title: string, entries: Entry[], onClose: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'drawer';

  const header = document.createElement('header');
  const h3 = document.createElement('h3');
  h3.textContent = `Rows behind ${title}`;
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  const close = document.createElement('button');
  close.className = 'icon-btn';
  close.textContent = 'Close ✕';
  close.addEventListener('click', onClose);
  header.append(h3, spacer, close);

  const table = document.createElement('table');
  table.className = 'rows';
  table.innerHTML = `
    <thead>
      <tr>
        <th>month</th><th>item</th><th>amount forecast</th><th>amount actual</th><th>class</th>
      </tr>
    </thead>`;

  const tbody = document.createElement('tbody');
  for (const e of [...entries].sort((a, b) => a.sourceRow - b.sourceRow)) {
    const tr = document.createElement('tr');
    if (e.misfiled) tr.className = 'flagged';
    const cells = [
      e.rawMonth,
      e.sourceLabel,
      e.forecast === null ? '' : String(e.forecast),
      e.actual === null ? '' : String(e.actual),
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.append(td);
    }
    const cls = document.createElement('td');
    cls.className = 'derived';
    cls.textContent = e.cls;
    tr.append(cls);
    tbody.append(tr);
  }

  const tfoot = document.createElement('tfoot');
  const totalF = entries.reduce((a, e) => a + (e.forecast ?? 0), 0);
  const totalA = entries.reduce((a, e) => a + (e.actual ?? 0), 0);
  tfoot.innerHTML = `<tr><td colspan="2">${entries.length} rows</td><td>${fmtCZK(
    totalF,
  )}</td><td>${fmtCZK(totalA)}</td><td></td></tr>`;

  table.append(tbody, tfoot);
  el.append(header, table);
  return el;
}
