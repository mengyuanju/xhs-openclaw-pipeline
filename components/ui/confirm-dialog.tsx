'use client';

import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type ConfirmDialogOptions = {
  title?: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
};

type ConfirmDialogRequest = ConfirmDialogOptions & {
  id: number;
};

type ConfirmDialogFunction = (options: ConfirmDialogOptions | string) => Promise<boolean>;

const ConfirmDialogContext = createContext<ConfirmDialogFunction | null>(null);

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmDialogRequest | null>(null);
  const requestIdRef = useRef(0);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const resolve = resolverRef.current;
    const returnFocus = returnFocusRef.current;
    resolverRef.current = null;
    returnFocusRef.current = null;
    setRequest(null);
    resolve?.(confirmed);
    if (returnFocus?.isConnected) {
      requestAnimationFrame(() => returnFocus.focus());
    }
  }, []);

  const confirm = useCallback<ConfirmDialogFunction>((options) => {
    resolverRef.current?.(false);
    requestIdRef.current += 1;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const normalized = typeof options === 'string' ? { description: options } : options;
    setRequest({ id: requestIdRef.current, ...normalized });
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  useEffect(() => () => resolverRef.current?.(false), []);

  return (
    <ConfirmDialogContext.Provider value={confirm}>
      {children}
      <AlertDialogPrimitive.Root
        open={Boolean(request)}
        onOpenChange={(open) => {
          if (!open && resolverRef.current) settle(false);
        }}
      >
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Overlay className="dialog-overlay fixed inset-0 z-50" />
          <AlertDialogPrimitive.Content className="confirm-dialog-content fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2">
            <div className="confirm-dialog-header">
              <AlertDialogPrimitive.Title className="confirm-dialog-title">
                {request?.title || '请确认此操作'}
              </AlertDialogPrimitive.Title>
              <AlertDialogPrimitive.Description className="confirm-dialog-description">
                {request?.description}
              </AlertDialogPrimitive.Description>
            </div>
            <div className="confirm-dialog-footer">
              <AlertDialogPrimitive.Cancel asChild>
                <button className="button" type="button" onClick={() => settle(false)}>
                  {request?.cancelLabel || '取消'}
                </button>
              </AlertDialogPrimitive.Cancel>
              <AlertDialogPrimitive.Action asChild>
                <button
                  className={`button ${request?.tone === 'danger' ? 'danger' : 'primary'}`}
                  type="button"
                  onClick={() => settle(true)}
                >
                  {request?.confirmLabel || '确认'}
                </button>
              </AlertDialogPrimitive.Action>
            </div>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>
    </ConfirmDialogContext.Provider>
  );
}

export function useConfirmDialog() {
  const confirm = useContext(ConfirmDialogContext);
  if (!confirm) throw new Error('useConfirmDialog must be used inside ConfirmDialogProvider');
  return confirm;
}
