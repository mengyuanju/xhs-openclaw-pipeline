'use client';

import { useEffect, useRef, useState } from 'react';
import { init, use } from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, AriaComponent } from 'echarts/components';
import { LabelLayout } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';
use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, AriaComponent, LabelLayout, CanvasRenderer]);

export type ChartProps = {
  label: string; labels: string[]; series: { name: string; values: (number | null)[] }[];
  bar?: boolean; horizontal?: boolean; unit?: string;
};
export default function StatisticsChart({ label, labels, series, bar = false, horizontal = false, unit = '项' }: ChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof init> | null>(null);
  const [chartVersion, setChartVersion] = useState(0);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const initializeOrResize = () => {
      if (!element.clientWidth || !element.clientHeight) return;
      if (!chartRef.current) {
        chartRef.current = init(element);
        setChartVersion(version => version + 1);
      } else chartRef.current.resize();
    };
    const observer = new ResizeObserver(initializeOrResize);
    observer.observe(element);
    const frame = requestAnimationFrame(initializeOrResize);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const style = getComputedStyle(document.documentElement);
    const token = (name: string) => style.getPropertyValue(name).trim();
    const category = { type: 'category' as const, data: labels, axisLabel: { color: token('--muted'), width: 84, overflow: 'truncate' as const } };
    const value = { type: 'value' as const, name: unit, minInterval: unit === '项' ? 1 : undefined,
      axisLabel: { color: token('--muted') }, splitLine: { lineStyle: { color: token('--line') } } };
    const valueLabel = unit === '项' ? '{c}' : `{c} ${unit}`;
    chart.setOption({
      animation: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      aria: { enabled: true, decal: { show: true }, label: { description: label } },
      color: [token('--red'), token('--green'), token('--amber')],
      textStyle: { fontFamily: 'inherit', color: token('--ink') },
      tooltip: { trigger: 'axis', renderMode: 'richText', valueFormatter: (raw: unknown) => raw == null ? '暂无样本' : `${raw}${unit === '项' ? ' 项' : ` ${unit}`}` },
      legend: { top: 0, textStyle: { color: token('--muted') } },
      grid: { top: 54, left: horizontal ? 104 : 52, right: horizontal ? 76 : 28, bottom: 36 },
      xAxis: horizontal ? value : category, yAxis: horizontal ? { ...category, inverse: true } : value,
      series: series.map(item => ({ name: item.name, data: item.values, type: bar ? 'bar' : 'line',
        barMaxWidth: 26, showSymbol: true, symbolSize: labels.length <= 14 ? 7 : 5, connectNulls: false,
        label: { show: true, position: horizontal ? 'right' : 'top', distance: 6, formatter: valueLabel,
          color: token('--ink'), fontSize: 11, backgroundColor: token('--surface'), borderRadius: 3, padding: [2, 3] },
        labelLayout: { hideOverlap: true }, lineStyle: { width: 2 }, emphasis: { focus: 'series' } })),
    }, { notMerge: true });
  }, [label, labels, series, bar, horizontal, unit, chartVersion]);
  return <div className="job-stats-chart" ref={container} role="img" aria-label={label} />;
}
