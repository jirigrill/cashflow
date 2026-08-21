import type { ViewState } from './state.ts';

/**
 * The sticky top header (~56px) holding the global controls: the year
 * multi-select, the everyday/investing toggle, refresh, and the theme toggle.
 *
 * Prototype position — whether the global controls belong here at all is one of
 * the questions this build exists to answer.
 */
export interface HeaderHandlers {
  onToggleYear: (year: number) => void;
  onToggleInvesting: () => void;
  onRefresh: () => void;
  onToggleTheme: () => void;
}

export function renderHeader(
  years: number[],
  state: ViewState,
  theme: 'light' | 'dark',
  h: HeaderHandlers,
): HTMLElement {
  const el = document.createElement('header');
  el.className = 'topbar';

  const h1 = document.createElement('h1');
  h1.textContent = 'Cashflow';
  el.append(h1);

  const yearsLabel = document.createElement('span');
  yearsLabel.className = 'field-label';
  yearsLabel.textContent = 'Years';
  el.append(yearsLabel);

  const yearsWrap = document.createElement('div');
  yearsWrap.className = 'years';
  for (const y of years) {
    const b = document.createElement('button');
    b.textContent = String(y);
    b.setAttribute('aria-pressed', String(state.years.includes(y)));
    b.addEventListener('click', () => h.onToggleYear(y));
    yearsWrap.append(b);
  }
  el.append(yearsWrap);

  const inv = document.createElement('button');
  inv.className = 'pill';
  inv.textContent = state.includeInvesting ? 'Everyday + investing' : 'Everyday only';
  inv.setAttribute('aria-pressed', String(state.includeInvesting));
  inv.title =
    'Views 1–4 are everyday-only by default: investing churn is ~10× the everyday signal.';
  inv.addEventListener('click', h.onToggleInvesting);
  el.append(inv);

  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  el.append(spacer);

  const refresh = document.createElement('button');
  refresh.className = 'icon-btn';
  refresh.textContent = '↻ Refresh';
  refresh.addEventListener('click', h.onRefresh);
  el.append(refresh);

  const themeBtn = document.createElement('button');
  themeBtn.className = 'icon-btn';
  themeBtn.textContent = theme === 'dark' ? '☀ Light' : '☾ Dark';
  themeBtn.addEventListener('click', h.onToggleTheme);
  el.append(themeBtn);

  return el;
}

/**
 * The monthly/annual toggle. It exists only on views 1 and 3, and only when ≥2
 * years are selected — a control that appears and disappears needs a stable
 * home, which is one of the open questions.
 *
 * Prototype position: in the card header of the view it belongs to.
 */
export function renderGranularityToggle(
  state: ViewState,
  onToggle: () => void,
): HTMLElement | null {
  if (state.years.length < 2) return null;
  const b = document.createElement('button');
  b.className = 'pill';
  b.textContent = state.granularity === 'annual' ? 'Annual' : 'Monthly';
  b.setAttribute('aria-pressed', String(state.granularity === 'annual'));
  b.title = 'Appears only when ≥2 years are selected — one bar is not a chart.';
  b.addEventListener('click', onToggle);
  return b;
}
