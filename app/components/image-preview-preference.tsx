'use client';

import { Button } from '@/components/ui/button';

import { useSyncExternalStore } from 'react';

export type PreviewMode = 'actual' | 'fit';
const storageKey = 'xhs.image-preview.default-mode';
const changeEvent = 'image-preview-preference-change';
let fallbackMode: PreviewMode = 'actual';
let memoryOnly = false;

function readMode(): PreviewMode {
  if (memoryOnly) return fallbackMode;
  try {
    const saved = window.localStorage.getItem(storageKey);
    return saved === 'fit' ? 'fit' : 'actual';
  } catch {
    return fallbackMode;
  }
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(changeEvent, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(changeEvent, onChange);
  };
}

export function useDefaultPreviewMode() {
  return useSyncExternalStore(subscribe, readMode, (): PreviewMode => 'actual');
}

export function ImagePreviewPreference() {
  const mode = useDefaultPreviewMode();
  return <Button unstyled
    type="button"
    role="switch"
    aria-label="默认完整预览"
    aria-checked={mode === 'fit'}
    className="image-preview-preference"
    title="记住当前浏览器的默认预览模式；关闭时默认按 100% 显示"
    onClick={() => {
      fallbackMode = mode === 'fit' ? 'actual' : 'fit';
      try {
        window.localStorage.setItem(storageKey, fallbackMode);
        memoryOnly = false;
      } catch {
        memoryOnly = true;
      }
      window.dispatchEvent(new Event(changeEvent));
    }}
  >
    <span className="image-preview-preference-track" aria-hidden="true"><span /></span>
    <span>默认完整预览</span>
    <strong aria-hidden="true">{mode === 'fit' ? '完整' : '100%'}</strong>
  </Button>;
}
