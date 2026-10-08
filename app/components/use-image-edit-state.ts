'use client';
import { useEffect, useRef } from 'react';
import { readImageEditState, type ImageEditState } from './image-edit-state';
import { imageEditPollDelay } from '../../src/image-edit-state-cache.mjs';
import { subscribeWorkspaceUpdates } from './workspace-updates';

/** Full history is fetched on entry/change; unchanged polls read only compact state. */
export function useImageEditState({ taskId, standalone = false, enabled = true, refresh, onState, onError }: {
  taskId: number; standalone?: boolean; enabled?: boolean;
  refresh: (state?: ImageEditState, isCurrent?: () => boolean) => Promise<void>; onState?: (state: ImageEditState) => void; onError: (error: Error) => void;
}) {
  const callbacks = useRef({ refresh, onState, onError });
  callbacks.current = { refresh, onState, onError };
  useEffect(() => {
    if (!enabled) return;
    let stopped = false, pending = false, followUp = false, signature = '', loaded = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (fresh = false) => {
      if (stopped) return;
      if (pending) { followUp ||= fresh; return; }
      pending = true;
      let state: ImageEditState | undefined;
      try {
        state = await readImageEditState({ taskId, standalone, fresh });
        if (stopped) return;
        callbacks.current.onState?.(state);
        if (document.visibilityState === 'visible' && (!loaded || signature !== state.signature)) {
          await callbacks.current.refresh(state, () => !stopped);
          if (stopped) return;
          signature = state.signature; loaded = true;
        }
      } catch (error) { if (!stopped) callbacks.current.onError(error instanceof Error ? error : new Error('图片状态读取失败')); }
      finally {
        pending = false;
        if (!stopped) {
          clearTimeout(timer);
          if (followUp) { followUp = false; void poll(true); }
          else timer = setTimeout(() => void poll(), imageEditPollDelay(state, document.visibilityState === 'visible'));
        }
      }
    };
    const visible = () => { if (document.visibilityState === 'visible') void poll(true); };
    const unsubscribe = subscribeWorkspaceUpdates(() => void poll(true), {
      scopes: standalone ? ['image-editor'] : ['tasks','image-edits','task-details'], taskIds: [taskId],
    });
    void poll(true);
    document.addEventListener('visibilitychange', visible);
    return () => { stopped = true; clearTimeout(timer); unsubscribe(); document.removeEventListener('visibilitychange', visible); };
  }, [taskId, standalone, enabled]);
}
