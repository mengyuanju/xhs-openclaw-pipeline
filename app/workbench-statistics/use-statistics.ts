'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Filters, Statistics } from './types';

export function useStatistics(filters: Filters, enabled = true) {
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, typeof v === 'boolean' ? v ? '1' : '0' : String(v)])).toString();
  const [snapshot, setSnapshot] = useState<{ query: string; data: Statistics } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const trigger = useRef<(() => void) | null>(null);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      trigger.current = null;
      return;
    }
    let disposed = false, running = false, blocked = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    setError('');
    async function load(force = false) {
      if (disposed || running || blocked || document.hidden) return;
      clearTimeout(timer);
      running = true;
      setBusy(true);
      controller = new AbortController();
      let delay = 30_000;
      try {
        const response = await fetch(`/api/workbench-statistics?${query}${force ? '&refresh=1' : ''}`, {
          signal: controller.signal, cache: 'no-store',
        });
        const payload = await response.json();
        if (!response.ok) {
          if ([401, 403].includes(response.status)) {
            blocked = true;
            setSnapshot(null);
          }
          throw new Error(payload?.error?.message || '统计暂时无法读取');
        }
        if (disposed) return;
        const data = payload.data as Statistics;
        setSnapshot({ query, data });
        setError('');
        delay = Math.max(1500, data.retryAfterMs);
      } catch (caught) {
        if (!disposed) setError(caught instanceof Error ? caught.message : '统计暂时无法读取');
      } finally {
        running = false;
        if (!disposed) {
          setBusy(false);
          if (!blocked && !document.hidden) timer = setTimeout(() => { void load(); }, delay);
        }
      }
    }
    trigger.current = () => { void load(true); };
    const onVisibility = () => {
      if (document.hidden) clearTimeout(timer);
      else void load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      trigger.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, query]);
  useEffect(() => () => { if (cooldownTimer.current) clearTimeout(cooldownTimer.current); }, []);
  const refresh = useCallback(() => {
    if (!enabled || cooldown || busy) return;
    trigger.current?.();
    setCooldown(true);
    cooldownTimer.current = setTimeout(() => setCooldown(false), 15_000);
  }, [enabled, cooldown, busy]);
  return {
    data: enabled && snapshot?.query === query ? snapshot.data : null,
    creators: enabled ? snapshot?.data.creators : undefined,
    error: enabled ? error : '',
    busy: enabled && busy,
    cooldown: enabled && cooldown,
    refresh,
  };
}
