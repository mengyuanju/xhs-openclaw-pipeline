'use client';

import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useTextInputDialog } from '@/components/ui/text-input-dialog';
import { apiRequest } from './api-client';
import { createRequestId } from './request-id';

type ImageDiscardTarget = { samplingItemId: string }
  | { taskId: number; imageRunId: string; copyRevisionId: number };

export function ImageDiscardButton({ target, disabled, onBusyChange, onCompleted }: {
  target: ImageDiscardTarget; disabled?: boolean; onBusyChange?: (busy: boolean) => void;
  onCompleted: () => void | Promise<void>;
}) {
  const requestText = useTextInputDialog();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const draft = useRef('');
  const mutation = useRef<{ fingerprint: string; requestId: string } | null>(null);
  async function discard() {
    if (disabled || pending.current) return;
    pending.current = true; setBusy(true); onBusyChange?.(true);
    try {
      const note = await requestText({ title: '废弃图片任务',
        description: '确认后，整条任务将标记为已废弃并退出图片初审、返修和质检待办；文案、图片和历史记录保留。',
        label: '废弃原因（必填）', placeholder: '请说明这条图片任务为什么需要废弃',
        required: true, requiredMessage: '请填写废弃原因后再提交。', maxLength: 1000,
        defaultValue: draft.current, confirmLabel: '确认废弃', cancelLabel: '继续处理' });
      if (note === null) return;
      draft.current = note;
      const qa = 'samplingItemId' in target;
      const path = qa ? `/v1/image-qa/items/${encodeURIComponent(target.samplingItemId)}/discard`
        : `/v1/tasks/${target.taskId}/discard-images`;
      const payload = qa ? { note } : { note, imageRunId: target.imageRunId, expectedCopyRevisionId: target.copyRevisionId };
      const fingerprint = JSON.stringify({ path, payload });
      if (mutation.current?.fingerprint !== fingerprint) mutation.current = { fingerprint, requestId: createRequestId() };
      await apiRequest(`/api/control-plane${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, requestId: mutation.current.requestId }) });
      draft.current = '';
      toast.success('任务已废弃，原因已记录。');
      await onCompleted();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : '废弃失败，请重试；填写的原因已保留。');
    } finally { pending.current = false; setBusy(false); onBusyChange?.(false); }
  }
  return <Button unstyled className="button danger" type="button" disabled={disabled || busy}
    onClick={() => void discard()}><Trash2 size={15} />废弃任务</Button>;
}
