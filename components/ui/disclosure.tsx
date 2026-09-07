'use client';

import { createContext, useContext, useId, useState, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

const DisclosureContext = createContext<{ open: boolean; toggle: () => void; id: string } | null>(null);

function useDisclosure() {
  const context = useContext(DisclosureContext);
  if (!context) throw new Error('Disclosure controls must be inside Disclosure');
  return context;
}

export function Disclosure({ open, defaultOpen = false, onOpenChange, className, children, ...props }: ComponentProps<'div'> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const expanded = open ?? localOpen;
  const id = useId();
  function toggle() {
    if (open === undefined) setLocalOpen(!expanded);
    onOpenChange?.(!expanded);
  }
  return <DisclosureContext.Provider value={{ open: expanded, toggle, id }}>
    <div {...props} className={cn('disclosure', className)} data-state={expanded ? 'open' : 'closed'}>{children}</div>
  </DisclosureContext.Provider>;
}

export function DisclosureTrigger({ className, onClick, ...props }: ComponentProps<'button'>) {
  const { open, toggle, id } = useDisclosure();
  return <Button {...props} unstyled type="button" className={cn('disclosure-trigger', className)}
    data-slot="disclosure-trigger" id={`${id}-trigger`} aria-expanded={open} aria-controls={`${id}-content`}
    onClick={event => { onClick?.(event); if (!event.defaultPrevented) toggle(); }} />;
}

export function DisclosureContent({ className, ...props }: ComponentProps<'div'>) {
  const { open, id } = useDisclosure();
  return <div {...props} className={cn('disclosure-content', className)} id={`${id}-content`} hidden={!open} />;
}
