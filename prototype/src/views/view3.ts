import type { EChartsOption } from 'echarts';
import type { Class, Entry } from '../domain.ts';
import { ALL_CLASSES, EVERYDAY_CLASSES, sumActual, sumForecast } from '../aggregate.ts';
import { baseOption, categoryAxis, valueAxis, type Palette } from '../chart.ts';
import { slice } from './view1.ts';

/**
 * View 3 — Forecast vs actual per month, with variance.
 * Answers "compare forecasts vs reality".
 *
 * The y-scale is pinned across the selected years (`yAxis.min`/`max` computed
 * over both series) so changing the year selection does not silently rescale
 * the comparison — the surviving substance of the retired `filterMode` flag.
 */
export function view3(
  entries: Entry[],
  granularity: 'monthly' | 'annual',
  includeInvesting: boolean,
  p: Palette,
): EChartsOption {
  const slices = slice(entries, granularity);
  const classes: Class[] = includeInvesting ? ALL_CLASSES : EVERYDAY_CLASSES;

  const forecast = slices.map((s) => Math.round(sumForecast(s.entries, classes)));
  // The forecast series runs on through unreported months; the actual stops.
  const actual = slices.map((s) => (s.unreported ? null : Math.round(sumActual(s.entries, classes))));
  const variance = slices.map((_s, i) => {
    const a = actual[i];
    return a === null ? null : a - forecast[i];
  });

  const all = [...forecast, ...actual.filter((v): v is number => v !== null)];
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const pad = Math.max(1, Math.round((hi - lo) * 0.08));

  return {
    ...baseOption(p),
    xAxis: categoryAxis(p, slices.map((s) => s.label)),
    yAxis: [
      { ...valueAxis(p), min: lo - pad, max: hi + pad },
      { ...valueAxis(p, 'variance'), min: lo - pad, max: hi + pad, splitLine: { show: false } },
    ],
    series: [
      {
        name: 'Forecast',
        type: 'bar',
        data: forecast,
        itemStyle: { color: p.forecast, opacity: 0.5 },
      },
      {
        name: 'Actual',
        type: 'bar',
        data: actual,
        itemStyle: { color: p.net },
      },
      {
        name: 'Variance (actual − forecast)',
        type: 'line',
        yAxisIndex: 1,
        data: variance,
        connectNulls: false,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { color: p.spend, width: 1.5, type: 'dashed' },
        itemStyle: { color: p.spend },
        // Same reason as view 1: the overlay line would swallow bar clicks and
        // carries no month of its own, so the drawer could never open.
        silent: true,
      },
    ],
  };
}
