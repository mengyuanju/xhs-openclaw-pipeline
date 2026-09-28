'use client';

import { useEffect, type ComponentProps } from 'react';
import { toast, Toaster as Sonner } from 'sonner';

type ToasterProps = ComponentProps<typeof Sonner>;

export function Toaster({ style, ...props }: ToasterProps) {
  return <Sonner
    closeButton
    duration={6_000}
    offset={20}
    position="top-center"
    richColors
    visibleToasts={4}
    // Radix modals disable pointer events on body; messages need their own hit area.
    style={{ pointerEvents: 'auto', ...style }}
    {...props}
  />;
}

export type ToastFeedbackTone = 'error' | 'info' | 'success' | 'warning';

export function ToastFeedback({
  id,
  message,
  tone = 'success',
  revision,
}: {
  id: string;
  message: string;
  tone?: ToastFeedbackTone;
  revision?: number | string;
}) {
  useEffect(() => {
    if (!message) {
      toast.dismiss(id);
      return;
    }
    toast[tone](message, { id });
  }, [id, message, revision, tone]);

  useEffect(() => () => { toast.dismiss(id); }, [id]);

  return null;
}
