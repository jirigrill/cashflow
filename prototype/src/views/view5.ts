import type { EChartsOption } from 'echarts';
import type { Entry } from '../domain.ts';
import { bucketByMonth, sumActual } from '../aggregate.ts';
import { baseOption, categoryAxis, valueAxis, type Palette } from '../chart.ts';

/**
 * View 5 — Investing: monthly in/out bars plus a cumulative net line on a
 * second y-axis. Answers "am I drawing down faster than I earn?".
 *
 * The monthly bars are noisy (asset sales swing from nothing to the year's
 * largest single figure and back); the cumulative line is the figure that
 * actually answers the question. This is the view that shows the portfolio
 * funding the everyday gap without needing the bank balances at all.
 */
export function view5(entries: Entry[], p: Palette): EChartsOption {
  const buckets = bucketByMonth(entries);

  const sold = buckets.map((b) => (b.unreported ? null : Math.round(sumActual(b.entries, ['Asset sales']))));
  const invested = buckets.map((b) => (b.unreported ? null : Math.round(sumActual(b.entries, ['Investments']))));

  let running = 0;
  const cumulative = buckets.map((b) => {
    if (b.unreported) return null;
    running += sumActual(b.entries, ['Asset sales', 'Investments']);
    return Math.round(running);
  });

  return {
    ...baseOption(p),
    xAxis: categoryAxis(p, buckets.map((b) => b.key)),
    yAxis: [valueAxis(p, 'monthly'), { ...valueAxis(p, 'cumulative'), splitLine: { show: false } }],
    series: [
      {
        name: 'Asset sales',
        type: 'bar',
        stack: 'flow',
        data: sold,
        itemStyle: { color: p.income },
      },
      {
        name: 'Investments',
        type: 'bar',
        stack: 'flow',
        data: invested,
        itemStyle: { color: p.spend },
      },
      {
        name: 'Cumulative net',
        type: 'line',
        yAxisIndex: 1,
        data: cumulative,
        connectNulls: false,
        symbol: 'none',
        areaStyle: { color: p.net, opacity: 0.1 },
        lineStyle: { color: p.net, width: 2.5 },
        z: 5,
        // The filled area covers the plot, so it would swallow every bar click.
        // Silenced; the axis tooltip still reports the cumulative value.
        silent: true,
      },
    ],
  };
}
