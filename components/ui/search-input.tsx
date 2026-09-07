'use client';

import { Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Input } from './input';

type SearchInputProps = Omit<ComponentProps<'input'>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'ref'> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
};

export function SearchInput({ value, defaultValue = '', onValueChange, className, disabled, readOnly, ...props }: SearchInputProps) {
  const [localValue, setLocalValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const currentValue = value ?? localValue;
  const label = props['aria-label'] ?? props.placeholder ?? '搜索';

  useEffect(() => {
    const form = inputRef.current?.form;
    const reset = () => setLocalValue(defaultValue);
    form?.addEventListener('reset', reset);
    return () => form?.removeEventListener('reset', reset);
  }, [defaultValue]);

  function update(next: string) {
    if (value === undefined) setLocalValue(next);
    onValueChange?.(next);
  }

  return <span className="ui-search" data-disabled={disabled || undefined}>
    <Search className="ui-search-icon" size={16} aria-hidden="true" />
    <Input {...props} ref={inputRef} type="search" aria-label={label} className={cn('ui-search-input', className)}
      value={currentValue} disabled={disabled} readOnly={readOnly} onChange={event => update(event.target.value)} />
    {currentValue && !readOnly && <Button unstyled className="ui-search-clear" type="button" disabled={disabled}
      aria-label={`清除${label}`} onClick={() => { update(''); inputRef.current?.focus(); }}>
      <X size={15} aria-hidden="true" />
    </Button>}
  </span>;
}
