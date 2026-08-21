import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';
import { fmtCZK, fmtCompact } from './aggregate.ts';

export interface Palette {
  ink: string;
  inkDim: string;
  line: string;
  surface: string;
  income: string;
  spend: string;
  net: string;
  forecast: string;
}

export function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  return {
    ink: v('--ink'),
    inkDim: v('--ink-dim'),
    line: v('--line'),
    surface: v('--surface'),
    income: v('--income'),
    spend: v('--spend'),
    net: v('--net'),
    forecast: v('--forecast'),
  };
}

/** Shared chrome so every chart reads the same. */
export function baseOption(p: Palette): EChartsOption {
  return {
    animationDuration: 220,
    grid: { left: 64, right: 56, top: 44, bottom: 56, containLabel: true },
    textStyle: { color: p.ink, fontFamily: 'inherit' },
    legend: {
      type: 'scroll',
      top: 6,
      textStyle: { color: p.inkDim, fontSize: 11 },
      inactiveColor: p.line,
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: p.surface,
      borderColor: p.line,
      textStyle: { color: p.ink, fontSize: 12 },
      valueFormatter: (val) => fmtCZK(typeof val === 'number' ? val : null),
    },
  };
}

export function categoryAxis(p: Palette, data: string[]): echarts.XAXisComponentOption {
  return {
    type: 'category',
    data,
    axisLine: { lineStyle: { color: p.line } },
    axisLabel: { color: p.inkDim, fontSize: 11 },
    axisTick: { show: false },
  };
}

export function valueAxis(p: Palette, name?: string): echarts.YAXisComponentOption {
  return {
    type: 'value',
    name,
    nameTextStyle: { color: p.inkDim, fontSize: 11 },
    axisLabel: { color: p.inkDim, fontSize: 11, formatter: (v: number) => fmtCompact(v) },
    splitLine: { lineStyle: { color: p.line, type: 'dashed' } },
  };
}

/** Mount (or re-mount) a chart into a container, disposing any prior instance. */
export function mount(el: HTMLElement, option: EChartsOption): echarts.ECharts {
  const existing = echarts.getInstanceByDom(el);
  if (existing) existing.dispose();
  const chart = echarts.init(el, undefined, { renderer: 'canvas' });
  chart.setOption(option);
  // Exposed so the inspection harness can hit-test real bars rather than guess
  // pixel coordinates. Prototype affordance only.
  (window as unknown as { echarts?: typeof echarts }).echarts = echarts;
  return chart;
}
