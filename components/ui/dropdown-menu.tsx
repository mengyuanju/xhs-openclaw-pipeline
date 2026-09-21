'use client';

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export function DropdownMenu(props: ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root {...props} />;
}

export function DropdownMenuTrigger(props: ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      data-slot="dropdown-menu-content"
      sideOffset={sideOffset}
      className={cn('ui-dropdown-content', className)}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>;
}

export function DropdownMenuItem({
  className,
  tone,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item> & { tone?: 'danger' }) {
  return <DropdownMenuPrimitive.Item
    data-slot="dropdown-menu-item"
    data-tone={tone}
    className={cn('ui-dropdown-item', className)}
    {...props}
  />;
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator
    data-slot="dropdown-menu-separator"
    className={cn('ui-dropdown-separator', className)}
    {...props}
  />;
}
