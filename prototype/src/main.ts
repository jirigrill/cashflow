import type { EChartsOption } from 'echarts';
import type { ECElementEvent } from 'echarts';
import type { Entry, Tab } from './domain.ts';
import { collectIssues, monthKey } from './aggregate.ts';
import { loadTabs } from './parse.ts';
import { mount, readPalette } from './chart.ts';
import { renderDrawer } from './drawer.ts';
import { renderGranularityToggle, renderHeader } from './header.ts';
import { renderIssuesPanel, renderStrip } from './panels.ts';
import { readState, readTheme, writeState, writeTheme, type ViewState } from './state.ts';
import { view1, slice } from './views/view1.ts';
import { view2 } from './views/view2.ts';
import { view3 } from './views/view3.ts';
import { view4 } from './views/view4.ts';
import { view5 } from './views/view5.ts';

/**
 * THROWAWAY prototype — wayfinder ticket #8. Exists to be argued with.
 *
 * One scrolling dashboard, not tabs: the app is opened to *interrogate*, moving
 * between views to compare, with a routine glance as the entry point. Order is
 * 1 → 3 → 2 → 5 → 4 (1 and 3 adjacent so the appearing/disappearing
 * monthly/annual toggle has one neighbourhood; 4 last because it ignores the
 * year selector).
 */

interface ViewSpec {
  id: string;
  n: number;
  title: string;
  question: string;
  /** Views 1 and 3 carry the monthly/annual toggle. */
  granularity: boolean;
  /** View 4 ignores the year selector. */
  ignoresYears?: boolean;
  note?: string;
  build: (ctx: BuildContext) => EChartsOption;
  /** Maps a clicked data index back to the Entries behind it. */
  rowsFor: (ctx: BuildContext, e: ECElementEvent) => { title: string; entries: Entry[] } | null;
}

interface BuildContext {
  state: ViewState;
  /** Entries for the selected years. */
  selected: Entry[];
  /** Every Entry, all years — what view 4 uses. */
  all: Entry[];
  palette: ReturnType<typeof readPalette>;
}

const SPECS: ViewSpec[] = [
  {
    id: 'v1',
    n: 1,
    title: 'Monthly cashflow',
    question: 'what’s happening / what do I spend',
    granularity: true,
    note: 'tax is a single annual row of 300–384k, which is why April reads as a crater.',
    build: (c) => view1(c.selected, c.state.granularity, c.state.includeInvesting, c.palette),
    rowsFor: (c, e) => sliceRows(c, e),
  },
  {
    id: 'v3',
    n: 3,
    title: 'Forecast vs actual',
    question: 'compare forecasts vs reality',
    granularity: true,
    note: 'y-scale is pinned across the selected years, so changing the selection does not rescale the comparison. Unreported months stop the actual series and let the forecast run on.',
    build: (c) => view3(c.selected, c.state.granularity, c.state.includeInvesting, c.palette),
    rowsFor: (c, e) => sliceRows(c, e),
  },
  {
    id: 'v2',
    n: 2,
    title: 'Category breakdown',
    question: 'compare categories',
    granularity: false,
    note: 'sorted by magnitude, not a pie. Click a bar for the rows behind it.',
    build: (c) => view2(c.selected, c.state.includeInvesting, c.palette),
    rowsFor: (c, e) => {
      const name = String(e.name);
      const entries = c.selected.filter((x) => x.displayName === name);
      return entries.length ? { title: name, entries } : null;
    },
  },
  {
    id: 'v5',
    n: 5,
    title: 'Investing',
    question: 'am I drawing down faster than I earn?',
    granularity: false,
    note: 'the cumulative line is the answer; the monthly bars are noise. This is the portfolio funding the everyday gap — no bank balances needed.',
    build: (c) => view5(c.selected, c.palette),
    rowsFor: (c, e) => {
      const key = String(e.name);
      const entries = c.selected.filter(
        (x) =>
          monthKey(x.year, x.blockMonth) === key &&
          (x.cls === 'Asset sales' || x.cls === 'Investments'),
      );
      return entries.length ? { title: key, entries } : null;
    },
  },
  {
    id: 'v4',
    n: 4,
    title: 'Year-over-year category evolution',
    question: 'compare evolution over the years',
    granularity: false,
    ignoresYears: true,
    note: 'absent months are gaps, not zeros — Tereza rent ends rather than dropping to the axis. Legend-toggle to compare a subset.',
    build: (c) => view4(c.all, c.state.includeInvesting, c.palette),
    rowsFor: (c, e) => {
      const year = Number(e.name);
      const name = String(e.seriesName);
      const entries = c.all.filter((x) => x.year === year && x.displayName === name);
      return entries.length ? { title: `${name}, ${year}`, entries } : null;
    },
  },
];

/** Views 1 and 3 share slicing, so they share the click→rows mapping. */
function sliceRows(c: BuildContext, e: ECElementEvent) {
  const label = String(e.name);
  const slices = slice(c.selected, c.state.granularity);
  const found = slices.find((s) => s.label === label);
  return found ? { title: label, entries: found.entries } : null;
}

// ---------------------------------------------------------------------------

let tabs: Tab[] = [];
let state: ViewState;
let theme = readTheme();
/** Exactly one drawer is open at a time — it replaces, never accumulates. */
let openDrawer: { viewId: string; title: string; entries: Entry[] } | null = null;

async function boot() {
  writeTheme(theme);
  tabs = await loadTabs();
  state = readState(tabs.map((t) => t.year));
  render();
  addEventListener('resize', () => render());
}

function render() {
  const years = tabs.map((t) => t.year);
  writeState(state, years);

  const selectedTabs = tabs.filter((t) => state.years.includes(t.year));
  const ctx: BuildContext = {
    state,
    selected: selectedTabs.flatMap((t) => t.entries),
    all: tabs.flatMap((t) => t.entries),
    palette: readPalette(),
  };
  const issues = collectIssues(tabs);

  const app = document.getElementById('app')!;
  app.replaceChildren();

  app.append(
    renderHeader(years, state, theme, {
      onToggleYear: (y) => {
        const next = state.years.includes(y)
          ? state.years.filter((x) => x !== y)
          : [...state.years, y];
        // Never leave the selection empty — one year is the floor.
        if (next.length > 0) state.years = next;
        openDrawer = null;
        render();
      },
      onToggleInvesting: () => {
        state.includeInvesting = !state.includeInvesting;
        render();
      },
      onRefresh: async () => {
        tabs = await loadTabs();
        render();
      },
      onToggleTheme: () => {
        theme = theme === 'dark' ? 'light' : 'dark';
        writeTheme(theme);
        render();
      },
    }),
  );

  app.append(
    renderStrip(selectedTabs, issues, () => {
      document.getElementById('data-issues')?.scrollIntoView({ behavior: 'smooth' });
    }),
  );

  const main = document.createElement('main');
  for (const spec of SPECS) main.append(renderCard(spec, ctx));
  main.append(renderIssuesPanel(selectedTabs, issues));
  app.append(main);

  const foot = document.createElement('footer');
  foot.className = 'disclaimer';
  foot.textContent =
    'Throwaway prototype (wayfinder #8). Dev-mode source: the four data/*.csv exports, read directly in the browser — no server, no Google. Figures recomputed from entries; the tab’s own roll-ups are only ever a check.';
  app.append(foot);
}

function renderCard(spec: ViewSpec, ctx: BuildContext): HTMLElement {
  const card = document.createElement('section');
  card.className = 'card';

  const header = document.createElement('header');
  const h2 = document.createElement('h2');
  h2.textContent = `${spec.n}. ${spec.title}`;
  const q = document.createElement('span');
  q.className = 'q';
  q.textContent = spec.question;
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  header.append(h2, q, spacer);

  if (spec.granularity) {
    const toggle = renderGranularityToggle(ctx.state, () => {
      state.granularity = state.granularity === 'annual' ? 'monthly' : 'annual';
      openDrawer = null;
      render();
    });
    if (toggle) header.append(toggle);
  }

  // View 4 ignores the year selector, so it says so in the header *and* over the
  // chart: ticking 2026 only and seeing a four-year chart otherwise reads as a
  // bug, and page position alone is not enough of a signal.
  if (spec.ignoresYears) {
    const flag = document.createElement('span');
    flag.className = 'ignores-years';
    flag.textContent = `⃠ ignores the year filter — always all ${ctx.all.length ? new Set(ctx.all.map((e) => e.year)).size : 0} years`;
    header.append(flag);
  }

  card.append(header);

  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  const chartEl = document.createElement('div');
  chartEl.className = 'chart';
  wrap.append(chartEl);

  if (spec.ignoresYears) {
    const wm = document.createElement('div');
    wm.className = 'watermark';
    wm.textContent = 'all years, regardless of the header selection';
    wrap.append(wm);
  }
  card.append(wrap);

  if (spec.note) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = spec.note;
    card.append(note);
  }

  // The drawer opens inline beneath the chart that was clicked.
  if (openDrawer?.viewId === spec.id) {
    card.append(
      renderDrawer(openDrawer.title, openDrawer.entries, () => {
        openDrawer = null;
        render();
      }),
    );
  }

  // ECharts needs a laid-out container before init.
  requestAnimationFrame(() => {
    const chart = mount(chartEl, spec.build(ctx));
    chart.on('click', (e) => {
      const found = spec.rowsFor(ctx, e as ECElementEvent);
      if (!found) return;
      openDrawer = { viewId: spec.id, title: found.title, entries: found.entries };
      render();
    });
  });

  return card;
}

boot().catch((err) => {
  const app = document.getElementById('app')!;
  app.innerHTML = `<p class="loading">Failed to load: ${String(err)}</p>`;
});
