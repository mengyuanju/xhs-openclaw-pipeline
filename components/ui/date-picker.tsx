'use client';

import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './dialog';
import { Input } from './input';

function dateValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && dateValue(date) === value ? date : null;
}

export function DatePicker({ name, label, defaultValue = '', required, disabled }: {
  name: string; label: string; defaultValue?: string; required?: boolean; disabled?: boolean;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(() => dateValue(new Date()));
  const [month, setMonth] = useState(() => new Date());
  const [error, setError] = useState('');
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();

  useEffect(() => {
    const form = inputRef.current?.form;
    function reset() { setValue(defaultValue); setError(''); }
    form?.addEventListener('reset', reset);
    return () => form?.removeEventListener('reset', reset);
  }, [defaultValue]);

  useEffect(() => {
    inputRef.current?.setCustomValidity(value && !parseDate(value) ? '请输入有效日期，例如 2026-09-07' : '');
  }, [value]);

  function select(next: string) { setValue(next); setError(''); setOpen(false); }
  function moveMonth(delta: number) {
    const next = new Date(month.getFullYear(), month.getMonth() + delta, 1);
    setMonth(next); setFocused(dateValue(next));
  }

  return <div className="ui-date-field">
    <label htmlFor={id}>{label}</label>
    <div className="ui-date-input">
      <Input id={id} ref={inputRef} name={name} value={value} required={required} disabled={disabled} maxLength={10}
        placeholder="YYYY-MM-DD" autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
        onChange={event => { setValue(event.target.value); setError(''); }}
        onBlur={() => setError(value && !parseDate(value) ? '请输入有效日期，例如 2026-09-07' : '')} />
      <Dialog open={open} onOpenChange={next => {
        if (next) { const date = parseDate(value) ?? new Date(); setMonth(date); setFocused(dateValue(date)); }
        setOpen(next);
      }}>
        <DialogTrigger asChild><Button unstyled type="button" className="ui-date-open" aria-label={`选择${label}`} disabled={disabled}><CalendarDays size={16} aria-hidden="true" /></Button></DialogTrigger>
        <DialogContent className="ui-calendar-dialog" onOpenAutoFocus={event => { event.preventDefault(); gridRef.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus(); }}>
          <DialogTitle>{label}</DialogTitle><DialogDescription>选择日期或在输入框中输入年、月、日。方向键切换日期。</DialogDescription>
          <div className="ui-calendar-heading">
            <Button unstyled type="button" className="button small" aria-label="上个月" onClick={() => moveMonth(-1)}><ChevronLeft size={16} /></Button>
            <strong aria-live="polite">{month.getFullYear()} 年 {month.getMonth() + 1} 月</strong>
            <Button unstyled type="button" className="button small" aria-label="下个月" onClick={() => moveMonth(1)}><ChevronRight size={16} /></Button>
          </div>
          <div className="ui-calendar-week" aria-hidden="true">{['日', '一', '二', '三', '四', '五', '六'].map(day => <span key={day}>{day}</span>)}</div>
          <div className="ui-calendar-grid" ref={gridRef} role="group" aria-label="选择日期">
            {Array.from({ length: firstDay }, (_, i) => <span key={`blank-${i}`} />)}
            {Array.from({ length: days }, (_, i) => {
              const date = new Date(month.getFullYear(), month.getMonth(), i + 1);
              const day = dateValue(date);
              return <Button unstyled type="button" className="ui-calendar-day" key={day} aria-label={day} aria-pressed={value === day}
                aria-current={day === dateValue(new Date()) ? 'date' : undefined} tabIndex={focused === day ? 0 : -1}
                onClick={() => select(day)} onFocus={() => setFocused(day)} onKeyDown={event => {
                  const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -date.getDay(), End: 6 - date.getDay() }[event.key];
                  if (delta === undefined) return;
                  event.preventDefault();
                  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
                  setMonth(next); setFocused(dateValue(next));
                  requestAnimationFrame(() => gridRef.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus());
                }}>{i + 1}</Button>;
            })}
          </div>
          <div className="ui-calendar-actions"><Button unstyled className="button small" type="button" onClick={() => select('')}>清除</Button><Button unstyled className="button small primary" type="button" onClick={() => select(dateValue(new Date()))}>今天</Button></div>
        </DialogContent>
      </Dialog>
    </div>
    {error && <small id={`${id}-error`} role="alert">{error}</small>}
  </div>;
}
