'use client';

import { useCallback, useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import styles from './review-action-button.module.css';

export function ReviewActionButton({ disabled, disabledReason, className, type, onClick, onClickCapture,
  onFocus, onBlur, onPointerEnter, onPointerLeave, ...props
}: Omit<ComponentProps<typeof Button>, 'asChild' | 'ref'> & { disabledReason: string | null }) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number } | null>(null);
  const reason = disabled ? disabledReason : null;
  const hintVisible = Boolean(reason && position);

  const showHint = useCallback(() => {
    if (!reason || !buttonRef.current) return;
    const bounds = buttonRef.current.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 32);
    setPosition({ width, left: Math.max(16, Math.min(bounds.right - width, window.innerWidth - width - 16)),
      ...(bounds.top > 160 ? { bottom: window.innerHeight - bounds.top + 8 } : { top: bounds.bottom + 8 }) });
  }, [reason]);

  useEffect(() => {
    setPosition(null);
  }, [reason]);

  useEffect(() => {
    if (!hintVisible) return;
    // Dismiss the hint before the dialog's document-level Escape handler runs.
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setPosition(null);
    };
    window.addEventListener('keydown', dismissOnEscape, true);
    return () => window.removeEventListener('keydown', dismissOnEscape, true);
  }, [hintVisible]);

  useEffect(() => {
    if (!hintVisible) return;
    window.addEventListener('resize', showHint);
    window.addEventListener('scroll', showHint, true);
    return () => {
      window.removeEventListener('resize', showHint);
      window.removeEventListener('scroll', showHint, true);
    };
  }, [hintVisible, showHint]);

  return <>
    <Button {...props} ref={buttonRef} className={`${className ?? ''} ${styles.button}`}
      // Keep unavailable actions focusable so keyboard and touch users can read the reason.
      disabled={disabled && !reason} aria-disabled={reason ? true : undefined}
      aria-describedby={[props['aria-describedby'], reason ? id : null].filter(Boolean).join(' ') || undefined}
      type={reason ? 'button' : type}
      onClickCapture={event => {
        if (reason) { event.preventDefault(); event.stopPropagation(); showHint(); return; }
        onClickCapture?.(event);
      }}
      onClick={event => { if (!disabled) onClick?.(event); }}
      onFocus={event => { showHint(); onFocus?.(event); }}
      onBlur={event => { setPosition(null); onBlur?.(event); }}
      onPointerEnter={event => { showHint(); onPointerEnter?.(event); }}
      onPointerLeave={event => { if (document.activeElement !== buttonRef.current) setPosition(null); onPointerLeave?.(event); }} />
    {reason && <span id={id} className={styles.srOnly}>{reason}</span>}
    {reason && position && createPortal(<div className={styles.tooltip} style={position} role="tooltip">
      <strong>暂时无法操作</strong>{reason}
    </div>, document.body)}
  </>;
}
