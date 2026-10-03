'use client';

import { useEffect, useState, type ComponentProps, type ComponentType } from 'react';
import { Button } from '@/components/ui/button';

type HistoryProps = ComponentProps<typeof import('./operator-delivery-history').OperatorDeliveryHistory>;
type HistoryComponent = ComponentType<HistoryProps>;

export function LazyOperatorDeliveryHistory(props: HistoryProps) {
  const [History, setHistory] = useState<HistoryComponent | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void import('./operator-delivery-history').then(module => {
      if (active) setHistory(() => module.OperatorDeliveryHistory);
    }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt]);
  if (History) return <History {...props} />;
  if (failed) return <div role="alert">交付记录加载失败。<Button type="button" variant="outline"
    onClick={() => setAttempt(value => value + 1)}>重新加载交付记录</Button></div>;
  return <p role="status">正在加载交付记录…</p>;
}
