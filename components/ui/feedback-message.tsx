'use client';

import {
  AlertCircle,
  CheckCircle2,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

export type FeedbackMessageTone = 'info' | 'success' | 'warning' | 'error';

const toneIcons: Record<FeedbackMessageTone, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  error: AlertCircle,
};

const toneTitles: Record<FeedbackMessageTone, string> = {
  info: '提示',
  success: '操作成功',
  warning: '请注意',
  error: '操作未完成',
};

export function FeedbackMessage({
  tone = 'info',
  title,
  children,
  onDismiss,
}: {
  tone?: FeedbackMessageTone;
  title?: string;
  children: ReactNode;
  onDismiss?: () => void;
}) {
  const Icon = toneIcons[tone];
  return (
    <section
      className="feedback-message"
      data-tone={tone}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <Icon className="feedback-message-icon" size={18} aria-hidden="true" />
      <div className="feedback-message-content">
        <strong>{title || toneTitles[tone]}</strong>
        <div>{children}</div>
      </div>
      {onDismiss && (
        <button
          className="feedback-message-dismiss"
          type="button"
          aria-label="关闭反馈消息"
          onClick={onDismiss}
        >
          <X size={15} aria-hidden="true" />
        </button>
      )}
    </section>
  );
}
