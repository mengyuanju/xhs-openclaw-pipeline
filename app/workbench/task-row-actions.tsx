'use client';

import { Button } from '@/components/ui/button';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Ellipsis } from 'lucide-react';
import { Children, cloneElement, isValidElement, useRef, type ComponentProps, type ReactNode } from 'react';

// Keep the primary actions visible; the remaining buttons retain their handlers and permissions.
export function TaskRowActions({ taskId, busy, visibleActionCount = 1, children }: {
  taskId: number;
  busy: boolean;
  visibleActionCount?: number;
  children: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const actions = Children.toArray(children).filter(isValidElement<ComponentProps<'button'>>);
  const primaryActions = actions.slice(0, Math.max(1, Math.trunc(visibleActionCount)));
  const secondaryActions = actions.slice(primaryActions.length);

  return <div className="workbench-task-actions">
    {primaryActions}
    {secondaryActions.length > 0 && <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button unstyled ref={triggerRef} className="button small workbench-action-menu-trigger" type="button" disabled={busy}
          aria-label={`任务 #${taskId} 的更多操作`} title="更多操作">
          <Ellipsis size={16} aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="workbench-action-menu" align="end" sideOffset={6} collisionPadding={12}
          aria-label={`任务 #${taskId} 的操作`}>
          {secondaryActions.map((action) => <DropdownMenu.Item key={action.key} asChild disabled={action.props.disabled}>
            {cloneElement(action, { onClick: (event) => {
              // ConfirmDialog must return focus to a button that survives menu dismissal.
              triggerRef.current?.focus();
              action.props.onClick?.(event);
            } })}
          </DropdownMenu.Item>)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>}
  </div>;
}
