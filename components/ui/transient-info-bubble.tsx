'use client';

import { Info } from 'lucide-react';
import { useEffect, useRef } from 'react';

export function TransientInfoBubble({
  message,
  announcementKey,
  durationMs = 2_600,
  onDismiss,
}: {
  message: string | null;
  announcementKey?: string | number;
  durationMs?: number;
  onDismiss?: () => void;
}) {
  const onDismissRef = useRef(onDismiss);

  useEffect(() => { onDismissRef.current = onDismiss; }, [onDismiss]);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => onDismissRef.current?.(), durationMs);
    return () => window.clearTimeout(timer);
  }, [announcementKey, durationMs, message]);

  if (!message) return null;
  return <div key={announcementKey} className="transient-info-bubble" role="status" aria-live="polite">
    <Info aria-hidden="true" size={13} />
    <span>{message}</span>
  </div>;
}
