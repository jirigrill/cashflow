/**
 * View state lives in URL query params; theme in localStorage. Nothing else in
 * localStorage — a theme cannot make a number wrong, but a hidden year filter
 * can.
 */

export type Granularity = 'monthly' | 'annual';
export type Theme = 'light' | 'dark';

export interface ViewState {
  /** Whole-year multi-select. There is no continuous range filter. */
  years: number[];
  /** False = everyday only (Income + Spend); true = include investing. */
  includeInvesting: boolean;
  /** Only meaningful on views 1 and 3, and only when ≥2 years are selected. */
  granularity: Granularity;
  /** Per-view category deselections, keyed by view id. */
  hidden: Record<string, string[]>;
}

const THEME_KEY = 'cashflow-prototype:theme';

export function readTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function writeTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.dataset.theme = theme;
}

export function readState(availableYears: number[]): ViewState {
  const p = new URLSearchParams(location.search);
  const yearsParam = p.get('years');
  const currentYear = Math.max(...availableYears);
  const years = yearsParam
    ? yearsParam
        .split(',')
        .map(Number)
        .filter((y) => availableYears.includes(y))
    : [currentYear];

  const hidden: Record<string, string[]> = {};
  for (const [k, v] of p.entries()) {
    if (k.startsWith('hide.') && v) hidden[k.slice(5)] = v.split('~');
  }

  return {
    years: years.length > 0 ? years : [currentYear],
    includeInvesting: p.get('investing') === '1',
    granularity: p.get('gran') === 'annual' ? 'annual' : 'monthly',
    hidden,
  };
}

/** Default state = clean URL, so a pasted link always means something. */
export function writeState(state: ViewState, availableYears: number[]): void {
  const p = new URLSearchParams();
  const currentYear = Math.max(...availableYears);
  const isDefaultYears = state.years.length === 1 && state.years[0] === currentYear;
  if (!isDefaultYears) p.set('years', [...state.years].sort().join(','));
  if (state.includeInvesting) p.set('investing', '1');
  if (state.granularity === 'annual') p.set('gran', 'annual');
  for (const [view, cats] of Object.entries(state.hidden)) {
    if (cats.length > 0) p.set(`hide.${view}`, cats.join('~'));
  }
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}
