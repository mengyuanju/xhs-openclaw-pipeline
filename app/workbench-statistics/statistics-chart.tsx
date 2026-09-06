'use client';

import { useEffect, useRef } from 'react';
import { init, use } from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, AriaComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, AriaComponent, CanvasRenderer]);

export type ChartProps = {
  label: string; labels: string[]; series: { name: string; values: (number | null)[] }[];
  bar?: boolean; horizontal?: boolean; unit?: string;
};
export default function StatisticsChart({ label, labels, series, bar = false, horizontal = false, unit = '项' }: ChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof init> | null>(null);
  useEffect(() => {
    if (!container.current) return;
    const chart = init(container.current);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(container.current);
    return () => { observer.disconnect(); chart.dispose(); chartRef.current = null; };
  }, []);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const style = getComputedStyle(document.documentElement);
    const token = (name: string) => style.getPropertyValue(name).trim();
    const category = { type: 'category' as const, data: labels, axisLabel: { color: token('--muted'), width: 84, overflow: 'truncate' as const } };
    const value = { type: 'value' as const, name: unit, minInterval: unit === '项' ? 1 : undefined,
      axisLabel: { color: token('--muted') }, splitLine: { lineStyle: { color: token('--line') } } };
    chart.setOption({
      animation: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      aria: { enabled: true, decal: { show: true }, label: { description: label } },
      color: [token('--red'), token('--green'), token('--amber')],
      textStyle: { fontFamily: 'inherit', color: token('--ink') },
      tooltip: { trigger: 'axis', renderMode: 'richText' },
      legend: { top: 0, textStyle: { color: token('--muted') } },
      grid: { top: 45, left: horizontal ? 104 : 48, right: 24, bottom: 32 },
      xAxis: horizontal ? value : category, yAxis: horizontal ? { ...category, inverse: true } : value,
      series: series.map(item => ({ name: item.name, data: item.values, type: bar ? 'bar' : 'line',
        barMaxWidth: 22, showSymbol: labels.length < 32, connectNulls: false })),
    });
  }, [label, labels, series, bar, horizontal, unit]);
  return <div className="job-stats-chart" ref={container} role="img" aria-label={label} />;
}
