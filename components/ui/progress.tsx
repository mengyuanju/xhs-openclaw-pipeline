import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Progress({ value, max = 100, className, children, ...props }: ComponentProps<'div'> & { value?: number; max?: number }) {
  const limit = Number.isFinite(max) && max > 0 ? max : 100;
  const current = value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(value, limit)) : undefined;
  return <div {...props} className={cn('ui-progress', className)} role="progressbar" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={current}>
    <div className="ui-progress-indicator" data-indeterminate={current === undefined || undefined} style={{ width: current === undefined ? '35%' : `${current / limit * 100}%` }} />
    {children && <span className="sr-only">{children}</span>}
  </div>;
}
