'use client';

import { useEffect, useRef, useState } from 'react';
import { init, use } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { AriaComponent, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import styles from './report.module.css';

use([LineChart, AriaComponent, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export type TrendLine = {
  name: string;
  color: string;
  values: (number | null)[];
  passed?: number[];
  decided?: number[];
};

type ChartProps = { label: string; dates: string[]; lines: TrendLine[]; rate?: boolean };
type TooltipPoint = { seriesIndex?: number; dataIndex?: number };

export default function AnnotationTrendChart({ label, dates, lines, rate = false }: ChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<ReturnType<typeof init> | null>(null);
  const renderedDates = useRef<string[] | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const initializeOrResize = () => {
      if (!element.clientWidth || !element.clientHeight) return;
      if (!chart.current) {
        chart.current = init(element);
        setVersion(value => value + 1);
      } else chart.current.resize();
    };
    const observer = new ResizeObserver(initializeOrResize);
    observer.observe(element);
    const frame = requestAnimationFrame(initializeOrResize);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      chart.current?.dispose();
      chart.current = null;
      renderedDates.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chart.current) return;
    const css = getComputedStyle(document.documentElement);
    const token = (name: string) => css.getPropertyValue(name).trim();
    const sameDates = renderedDates.current?.length === dates.length
      && renderedDates.current.every((date, index) => date === dates[index]);
    const previousZoom = sameDates && dates.length > 30
      ? (chart.current.getOption() as { dataZoom?: { start?: number; end?: number }[] }).dataZoom?.[0]
      : null;
    const zoom = previousZoom ? { start: previousZoom.start, end: previousZoom.end } : {};
    chart.current.setOption({
      animation: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      aria: { enabled: true, label: { description: label } },
      color: lines.map(line => line.color),
      textStyle: { fontFamily: 'inherit', color: token('--ink') },
      tooltip: {
        trigger: 'axis', renderMode: 'richText', axisPointer: { type: 'line' },
        formatter: (raw: unknown) => {
          const points = (Array.isArray(raw) ? raw : [raw]) as TooltipPoint[];
          const index = points[0]?.dataIndex;
          if (index == null) return '';
          const detail = points.map(point => {
            const line = lines[point.seriesIndex ?? -1];
            const position = point.dataIndex ?? -1;
            if (!line || position < 0) return '';
            const value = line.values[position];
            if (rate) {
              const passed = line.passed?.[position] ?? 0;
              const decided = line.decided?.[position] ?? 0;
              return `${line.name}：${value == null ? '—' : `${value.toFixed(2)}%`}（${passed} / ${decided} 轮次）`;
            }
            return `${line.name}：${value ?? 0} 次`;
          }).filter(Boolean);
          return [dates[index], ...detail].join('\n');
        },
      },
      legend: { type: 'scroll', selectedMode: false, top: 0, left: 0, right: 0, itemWidth: 16, itemHeight: 8,
        textStyle: { color: token('--muted'), fontSize: 11 } },
      grid: { top: 56, left: 16, right: 16, bottom: dates.length > 30 ? 62 : 24, containLabel: true },
      xAxis: { type: 'category', data: dates, boundaryGap: false,
        axisTick: { show: false }, axisLine: { lineStyle: { color: token('--line') } },
        axisLabel: { color: token('--muted'), hideOverlap: true,
          formatter: (value: string) => value.slice(5) } },
      yAxis: { type: 'value', min: 0, max: rate ? 100 : undefined,
        minInterval: rate ? undefined : 1,
        axisLabel: { color: token('--muted'), formatter: rate ? '{value}%' : '{value}' },
        splitLine: { lineStyle: { color: token('--line'), type: 'dashed' } } },
      dataZoom: dates.length > 30 ? [
        { type: 'inside', xAxisIndex: 0, filterMode: 'none', ...zoom },
        { type: 'slider', xAxisIndex: 0, filterMode: 'none', ...zoom, bottom: 8, height: 16,
          borderColor: token('--line'), fillerColor: 'rgba(98, 148, 135, .15)' },
      ] : [],
      series: lines.map(line => ({ name: line.name, type: 'line', data: line.values,
        showSymbol: rate || dates.length <= 14, symbolSize: 6, connectNulls: false,
        lineStyle: { width: 2 }, emphasis: { focus: 'series' } })),
    }, { notMerge: true });
    renderedDates.current = dates;
  }, [label, dates, lines, rate, version]);

  return <div className={styles.trendChart} ref={container} role="img" aria-label={label} />;
}
