'use client';

import { useEffect, useRef, useState } from 'react';
import { init, use } from 'echarts/core';
import { LineChart, BarChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, AriaComponent, TitleComponent } from 'echarts/components';
import { LabelLayout } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';
use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, AriaComponent, TitleComponent,
  LabelLayout, CanvasRenderer]);

export type ChartProps = {
  label: string; labels: string[]; series: { name: string; values: (number | null)[] }[];
  variant?: 'line' | 'bar' | 'donut' | 'team'; bar?: boolean; horizontal?: boolean; unit?: string; area?: boolean;
};

export default function StatisticsChart({ label, labels, series, variant, bar = false,
  horizontal = false, unit = '项', area = false }: ChartProps) {
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
    const palette = [token('--red'), token('--green'), '#5b73d8', token('--amber'), '#8b63c7', '#2395a7', '#9b8b7d'];
    const chartType = variant ?? (bar ? 'bar' : 'line');
    if (chartType === 'donut') {
      const values = series[0]?.values ?? [];
      const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      chart.setOption({
        animation: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        aria: { enabled: true, decal: { show: false }, label: { description: label } },
        color: palette,
        textStyle: { fontFamily: 'inherit', color: token('--ink') },
        title: { text: total.toLocaleString('zh-CN'), subtext: '全部作业', left: 'center', top: '34%',
          textStyle: { color: token('--ink'), fontSize: 24, fontWeight: 700 },
          subtextStyle: { color: token('--muted'), fontSize: 11 } },
        tooltip: { trigger: 'item', renderMode: 'richText', valueFormatter: (raw: unknown) => `${raw} 项` },
        legend: { type: 'scroll', bottom: 0, left: 'center', itemWidth: 10, itemHeight: 10,
          textStyle: { color: token('--muted'), fontSize: 11 } },
        series: [{ name: series[0]?.name ?? '作业数', type: 'pie', radius: ['53%', '74%'], center: ['50%', '43%'],
          avoidLabelOverlap: true, minShowLabelAngle: 6,
          itemStyle: { borderColor: token('--surface'), borderWidth: 3, borderRadius: 7 },
          label: { show: true, formatter: (params: { name?: string; value?: unknown; percent?: number }) =>
            (params.percent ?? 0) >= 3 ? `${params.name ?? ''}\n${params.value ?? 0} 项` : '',
          color: token('--ink'), fontSize: 11, lineHeight: 16 },
          labelLine: { length: 10, length2: 8, lineStyle: { color: token('--line') } },
          labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
          emphasis: { scaleSize: 6, label: { fontWeight: 700 } },
          data: labels.map((name, index) => ({ name, value: values[index] ?? 0 })) }],
      }, { notMerge: true });
      return;
    }
    if (chartType === 'team') {
      const category = { type: 'category' as const, data: labels, inverse: true, gridIndex: 0,
        axisTick: { show: false }, axisLine: { show: false },
        axisLabel: { color: token('--muted'), width: 74, overflow: 'truncate' as const, fontSize: 11 } };
      const valueAxis = (gridIndex: number, name: string) => ({ type: 'value' as const, gridIndex, name,
        minInterval: 1, nameLocation: 'middle' as const, nameGap: 25,
        nameTextStyle: { color: token('--muted'), fontSize: 10 }, axisLine: { show: false },
        axisTick: { show: false }, axisLabel: { color: token('--muted'), fontSize: 10 },
        splitLine: { lineStyle: { color: token('--line'), type: 'dashed' as const } } });
      const barSeries = (item: ChartProps['series'][number], index: number, axisIndex: number) => ({
        name: item.name, data: item.values, type: 'bar' as const, xAxisIndex: axisIndex, yAxisIndex: axisIndex,
        barMaxWidth: index === 2 ? 15 : 12, barGap: index === 1 ? '22%' : '18%',
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: 'right' as const, distance: 5,
          formatter: (params: { value?: unknown }) => Number(params.value) > 0 ? String(params.value) : '',
          color: token('--ink'), fontSize: 10 }, emphasis: { focus: 'series' as const },
      });
      chart.setOption({
        animation: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        animationDuration: 420,
        aria: { enabled: true, decal: { show: false }, label: { description: label } },
        color: palette,
        textStyle: { fontFamily: 'inherit', color: token('--ink') },
        tooltip: { trigger: 'axis', renderMode: 'richText', axisPointer: { type: 'shadow' },
          valueFormatter: (raw: unknown) => `${raw} 项` },
        legend: { top: 0, itemWidth: 13, itemHeight: 7, textStyle: { color: token('--muted'), fontSize: 10 } },
        grid: [
          { top: 42, left: 82, right: '35%', bottom: 34 },
          { top: 42, left: '75%', right: 28, bottom: 34 },
        ],
        xAxis: [valueAxis(0, '本期流转（项）'), valueAxis(1, '当前待处理（项）')],
        yAxis: [category, { ...category, gridIndex: 1, axisLabel: { show: false } }],
        series: [
          ...(series[0] ? [barSeries(series[0], 0, 0)] : []),
          ...(series[1] ? [barSeries(series[1], 1, 0)] : []),
          ...(series[2] ? [barSeries(series[2], 2, 1)] : []),
        ],
      }, { notMerge: true });
      return;
    }
    const category = { type: 'category' as const, data: labels, axisTick: { show: false },
      axisLine: { lineStyle: { color: token('--line') } },
      axisLabel: { color: token('--muted'), width: horizontal ? 98 : 58, overflow: 'truncate' as const,
        hideOverlap: true } };
    const value = { type: 'value' as const, name: unit, minInterval: unit === '项' ? 1 : undefined,
      nameTextStyle: { color: token('--muted'), padding: [0, 0, 0, 4] }, axisLine: { show: false },
      axisLabel: { color: token('--muted') }, splitLine: { lineStyle: { color: token('--line'), type: 'dashed' as const } } };
    chart.setOption({
      animation: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      animationDuration: 480,
      aria: { enabled: true, decal: { show: false }, label: { description: label } },
      color: palette,
      textStyle: { fontFamily: 'inherit', color: token('--ink') },
      tooltip: { trigger: 'axis', renderMode: 'richText', axisPointer: { type: chartType === 'bar' ? 'shadow' : 'line' },
        valueFormatter: (raw: unknown) => raw == null ? '暂无样本' : `${raw}${unit === '项' ? ' 项' : ` ${unit}`}` },
      legend: { top: 0, itemWidth: 14, itemHeight: 8, textStyle: { color: token('--muted'), fontSize: 11 } },
      grid: { top: 54, left: horizontal ? 118 : 48, right: horizontal ? 58 : 24, bottom: 36 },
      xAxis: horizontal ? value : category, yAxis: horizontal ? { ...category, inverse: true } : value,
      series: series.map(item => ({ name: item.name, data: item.values, type: chartType,
        barMaxWidth: 22, barGap: '18%', showSymbol: chartType === 'line', smooth: chartType === 'line',
        symbolSize: labels.length <= 14 ? 7 : 5, connectNulls: false,
        areaStyle: chartType === 'line' && area ? { opacity: .08 } : undefined,
        itemStyle: chartType === 'bar' ? { borderRadius: horizontal ? [0, 5, 5, 0] : [5, 5, 0, 0] } : undefined,
        label: { show: true, position: horizontal ? 'right' : 'top', distance: 6,
          formatter: (params: { value?: unknown }) => Number(params.value) === 0 || params.value == null
            ? '' : `${params.value}${unit === '项' ? '' : ` ${unit}`}`,
          color: token('--ink'), fontSize: 11, backgroundColor: token('--surface'), borderRadius: 3, padding: [2, 3] },
        labelLayout: { hideOverlap: true }, lineStyle: { width: 2.5 }, emphasis: { focus: 'series' } })),
    }, { notMerge: true });
  }, [label, labels, series, variant, bar, horizontal, unit, area, chartVersion]);
  return <div className="job-stats-chart" ref={container} role="img" aria-label={label} />;
}
