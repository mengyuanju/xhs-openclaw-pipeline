'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';
import { Textarea } from './input';

type TextInputDialogOptions = {
  title: string;
  description: string;
  label: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  defaultValue?: string;
  maxLength?: number;
  required?: boolean;
  requiredMessage?: string;
};

type TextInputDialogRequest = TextInputDialogOptions & {
  id: number;
};

type TextInputDialogFunction = (options: TextInputDialogOptions) => Promise<string | null>;

const TextInputDialogContext = createContext<TextInputDialogFunction | null>(null);

export function TextInputDialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<TextInputDialogRequest | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);
  const resolverRef = useRef<((value: string | null) => void) | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const fieldId = useId();
  const errorId = useId();

  const settle = useCallback((result: string | null) => {
    const resolve = resolverRef.current;
    const returnFocus = returnFocusRef.current;
    resolverRef.current = null;
    returnFocusRef.current = null;
    setRequest(null);
    setValue('');
    setError('');
    resolve?.(result);
    if (returnFocus?.isConnected) {
      requestAnimationFrame(() => returnFocus.focus());
    }
  }, []);

  const requestText = useCallback<TextInputDialogFunction>((options) => {
    resolverRef.current?.(null);
    requestIdRef.current += 1;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setValue(options.defaultValue ?? '');
    setError('');
    setRequest({ id: requestIdRef.current, ...options });
    return new Promise<string | null>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  useEffect(() => () => resolverRef.current?.(null), []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = value.trim();
    if (request?.required !== false && !normalized) {
      setError(request?.requiredMessage || '请填写内容后再继续。');
      return;
    }
    settle(normalized);
  }

  const maxLength = request?.maxLength ?? 1_000;
  const characterCount = [...value].length;

  return (
    <TextInputDialogContext.Provider value={requestText}>
      {children}
      <Dialog
        open={Boolean(request)}
        onOpenChange={(open) => {
          if (!open && resolverRef.current) settle(null);
        }}
      >
        <DialogContent className="text-input-dialog-content">
          <form className="text-input-dialog-form" key={request?.id} onSubmit={submit}>
            <header className="text-input-dialog-header">
              <DialogTitle>{request?.title}</DialogTitle>
              <DialogDescription>{request?.description}</DialogDescription>
            </header>
            <div className="text-input-dialog-field">
              <div className="text-input-dialog-label-row">
                <label htmlFor={fieldId}>{request?.label}</label>
                <span aria-live="polite">{characterCount}/{maxLength}</span>
              </div>
              <Textarea
                id={fieldId}
                value={value}
                rows={5}
                maxLength={maxLength}
                aria-required={request?.required !== false}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : undefined}
                placeholder={request?.placeholder}
                onChange={(event) => {
                  setValue(event.target.value);
                  if (error) setError('');
                }}
              />
              {error && <p className="text-input-dialog-error" id={errorId} role="alert">{error}</p>}
            </div>
            <footer className="text-input-dialog-footer">
              <Button unstyled className="button" type="button" onClick={() => settle(null)}>
                {request?.cancelLabel || '取消'}
              </Button>
              <Button unstyled className="button primary" type="submit">
                {request?.confirmLabel || '继续'}
              </Button>
            </footer>
          </form>
        </DialogContent>
      </Dialog>
    </TextInputDialogContext.Provider>
  );
}

export function useTextInputDialog() {
  const requestText = useContext(TextInputDialogContext);
  if (!requestText) throw new Error('useTextInputDialog must be used inside TextInputDialogProvider');
  return requestText;
}
