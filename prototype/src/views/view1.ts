import type { EChartsOption } from 'echarts';
import type { Class, Entry } from '../domain.ts';
import { ALL_CLASSES, EVERYDAY_CLASSES, bucketByMonth, sumActual } from '../aggregate.ts';
import { baseOption, categoryAxis, valueAxis, type Palette } from '../chart.ts';

export interface Slice {
  /** Axis label: `2025-07` monthly, `2025` annual. */
  label: string;
  entries: Entry[];
  unreported: boolean;
}

/** Monthly slices, or one slice per year when the annual toggle is on. */
export function slice(entries: Entry[], granularity: 'monthly' | 'annual'): Slice[] {
  if (granularity === 'monthly') {
    return bucketByMonth(entries).map((b) => ({
      label: b.key,
      entries: b.entries,
      unreported: b.unreported,
    }));
  }
  const byYear = new Map<number, Entry[]>();
  for (const e of entries) {
    const list = byYear.get(e.year) ?? [];
    list.push(e);
    byYear.set(e.year, list);
  }
  return [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, list]) => ({ label: String(year), entries: list, unreported: false }));
}

/**
 * View 1 — Monthly cashflow: income vs spend bars, net line overlaid.
 * Answers "what's happening / what do I spend".
 */
export function view1(
  entries: Entry[],
  granularity: 'monthly' | 'annual',
  includeInvesting: boolean,
  p: Palette,
): EChartsOption {
  const slices = slice(entries, granularity);
  const classes: Class[] = includeInvesting ? ALL_CLASSES : EVERYDAY_CLASSES;

  // Unreported months carry no actual — the series stops rather than dropping
  // to the axis, so a not-yet-happened month does not read as a catastrophe.
  const val = (s: Slice, cs: Class[]) => (s.unreported ? null : Math.round(sumActual(s.entries, cs)));

  const income = slices.map((s) => val(s, ['Income']));
  const spend = slices.map((s) => val(s, ['Spend']));
  const sold = slices.map((s) => val(s, ['Asset sales']));
  const invested = slices.map((s) => val(s, ['Investments']));
  const net = slices.map((s) => val(s, classes));

  const series: EChartsOption['series'] = [
    { name: 'Income', type: 'bar', stack: 'in', data: income, itemStyle: { color: p.income } },
    { name: 'Spend', type: 'bar', stack: 'out', data: spend, itemStyle: { color: p.spend } },
  ];
  if (includeInvesting) {
    series.push(
      { name: 'Asset sales', type: 'bar', stack: 'in', data: sold, itemStyle: { color: p.income, opacity: 0.55 } },
      { name: 'Investments', type: 'bar', stack: 'out', data: invested, itemStyle: { color: p.spend, opacity: 0.55 } },
    );
  }
  series.push({
    name: includeInvesting ? 'Net cashflow' : 'Everyday balance',
    type: 'line',
    data: net,
    connectNulls: false,
    symbol: 'circle',
    symbolSize: 6,
    lineStyle: { color: p.net, width: 2 },
    itemStyle: { color: p.net },
    z: 5,
    // The line is drawn over the bars, so it wins hit-testing and swallows the
    // clicks meant for them — and a line point carries no month, so the drawer
    // never opens. Silenced: the tooltip is axis-triggered, so nothing is lost.
    silent: true,
  });

  return {
    ...baseOption(p),
    xAxis: categoryAxis(p, slices.map((s) => s.label)),
    yAxis: valueAxis(p),
    series,
  };
}
