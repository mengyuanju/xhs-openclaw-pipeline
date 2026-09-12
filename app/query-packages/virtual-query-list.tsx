'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

type VirtualQueryListProps = {
  count: number;
  rowHeight: number;
  overscan?: number;
  className?: string;
  innerClassName?: string;
  rowClassName?: string;
  hasMore: boolean;
  loadingMore: boolean;
  onEndReached: () => void;
  rowKey: (index: number) => string | number;
  renderRow: (index: number) => ReactNode;
};

export function VirtualQueryList({
  count,
  rowHeight,
  overscan = 6,
  className,
  innerClassName,
  rowClassName,
  hasMore,
  loadingMore,
  onEndReached,
  rowKey,
  renderRow,
}: VirtualQueryListProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const lastEndRequestCountRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => setViewportHeight(Math.max(1, viewport.clientHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const range = useMemo(() => {
    const firstVisible = Math.floor(scrollTop / rowHeight);
    const visibleCount = Math.ceil(viewportHeight / rowHeight);
    const start = Math.max(0, firstVisible - overscan);
    const end = Math.min(count, firstVisible + visibleCount + overscan);
    return { start, end };
  }, [count, overscan, rowHeight, scrollTop, viewportHeight]);

  useEffect(() => {
    if (!hasMore) {
      lastEndRequestCountRef.current = null;
      return;
    }
    if (!loadingMore
        && range.end >= Math.max(0, count - overscan)
        && lastEndRequestCountRef.current !== count) {
      lastEndRequestCountRef.current = count;
      onEndReached();
    }
  }, [count, hasMore, loadingMore, onEndReached, overscan, range.end]);

  return <div
    ref={viewportRef}
    className={className}
    role="rowgroup"
    onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
  >
    <div className={innerClassName} style={{ height: count * rowHeight }}>
      {Array.from({ length: range.end - range.start }, (_, offset) => {
        const index = range.start + offset;
        return <div
          className={rowClassName}
          key={rowKey(index)}
          role="row"
          aria-rowindex={index + 2}
          style={{ height: rowHeight, transform: `translateY(${index * rowHeight}px)` }}
        >
          {renderRow(index)}
        </div>;
      })}
    </div>
  </div>;
}
