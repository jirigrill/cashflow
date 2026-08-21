import type { EChartsOption } from 'echarts';
import type { Class, Entry } from '../domain.ts';
import { ALL_CLASSES, EVERYDAY_CLASSES } from '../aggregate.ts';
import { baseOption, categoryAxis, valueAxis, type Palette } from '../chart.ts';

/**
 * View 4 — Year-over-year category evolution: one line per category across all
 * years, legend-toggleable. Answers "compare evolution over the years".
 *
 * **Ignores the year selector entirely** — it always shows every year, which is
 * why it needs an explicit in-chart signal (see the watermark in main.ts).
 *
 * Absent months are gaps, not zeros: a Category that stops (Tereza rent) breaks
 * its line rather than dropping to the axis.
 */
export function view4(allEntries: Entry[], includeInvesting: boolean, p: Palette): EChartsOption {
  const classes: Class[] = includeInvesting ? ALL_CLASSES : EVERYDAY_CLASSES;
  const years = [...new Set(allEntries.map((e) => e.year))].sort((a, b) => a - b);

  const byCategory = new Map<string, { name: string; perYear: Map<number, number> }>();
  for (const e of allEntries) {
    if (!classes.includes(e.cls)) continue;
    let c = byCategory.get(e.categoryId);
    if (!c) {
      c = { name: e.displayName, perYear: new Map() };
      byCategory.set(e.categoryId, c);
    }
    c.perYear.set(e.year, (c.perYear.get(e.year) ?? 0) + (e.actual ?? 0));
  }

  const series = [...byCategory.values()]
    .sort((a, b) => {
      const mag = (c: typeof a) => Math.max(...[...c.perYear.values()].map(Math.abs));
      return mag(b) - mag(a);
    })
    .map((c) => ({
      name: c.name,
      type: 'line' as const,
      // A year the Category is absent from is null — the line breaks.
      data: years.map((y) => (c.perYear.has(y) ? Math.round(c.perYear.get(y)!) : null)),
      connectNulls: false,
      symbol: 'circle' as const,
      symbolSize: 6,
      emphasis: { focus: 'series' as const },
    }));

  return {
    ...baseOption(p),
    grid: { left: 64, right: 56, top: 64, bottom: 56, containLabel: true },
    tooltip: { ...baseOption(p).tooltip, trigger: 'axis', order: 'valueDesc' },
    xAxis: categoryAxis(p, years.map(String)),
    yAxis: valueAxis(p),
    series,
  };
}
