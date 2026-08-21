import type { EChartsOption } from 'echarts';
import type { Class, Entry } from '../domain.ts';
import { ALL_CLASSES, EVERYDAY_CLASSES } from '../aggregate.ts';
import { baseOption, categoryAxis, valueAxis, type Palette } from '../chart.ts';

/**
 * View 2 — Category breakdown: sorted bars for the selected period, not a pie.
 * Answers "compare categories". Period rollup is inherent, so no granularity
 * toggle.
 */
export function view2(entries: Entry[], includeInvesting: boolean, p: Palette): EChartsOption {
  const classes: Class[] = includeInvesting ? ALL_CLASSES : EVERYDAY_CLASSES;
  const totals = new Map<string, { name: string; actual: number; forecast: number }>();

  for (const e of entries) {
    if (!classes.includes(e.cls)) continue;
    const t = totals.get(e.categoryId) ?? { name: e.displayName, actual: 0, forecast: 0 };
    t.actual += e.actual ?? 0;
    t.forecast += e.forecast ?? 0;
    totals.set(e.categoryId, t);
  }

  // Sort by magnitude — the biggest flows first, regardless of direction.
  const rows = [...totals.values()].sort((a, b) => Math.abs(b.actual) - Math.abs(a.actual));

  return {
    ...baseOption(p),
    grid: { left: 64, right: 56, top: 44, bottom: 96, containLabel: true },
    xAxis: {
      ...categoryAxis(p, rows.map((r) => r.name)),
      axisLabel: { color: p.inkDim, fontSize: 11, rotate: 38, interval: 0 },
    },
    yAxis: valueAxis(p),
    series: [
      {
        name: 'Actual',
        type: 'bar',
        data: rows.map((r) => Math.round(r.actual)),
        itemStyle: {
          color: (params) => ((params.value as number) >= 0 ? p.income : p.spend),
        },
      },
      {
        name: 'Forecast',
        type: 'bar',
        data: rows.map((r) => Math.round(r.forecast)),
        itemStyle: { color: p.forecast, opacity: 0.5 },
      },
    ],
  };
}
