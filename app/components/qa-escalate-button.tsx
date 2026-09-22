'use client';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useTextInputDialog } from '@/components/ui/text-input-dialog';
import { apiRequest } from './api-client';
import { notifyWorkspaceUpdated } from './workspace-updates';
import { createRequestId } from './request-id';

export function QaEscalateButton({ stage, itemId, revisionToken, disabled, onBusyChange, onCompleted }: {
  stage: 'COPY' | 'IMAGE'; itemId: string; revisionToken: string; disabled?: boolean;
  onBusyChange?: (busy: boolean) => void; onCompleted: () => void | Promise<void>;
}) {
  const requestText = useTextInputDialog();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false), draft = useRef('');
  const mutation = useRef<{ fingerprint: string; requestId: string } | null>(null);
  async function escalate() {
    if (disabled || pending.current) return;
    pending.current = true; setBusy(true); onBusyChange?.(true);
    try {
      const note = await requestText({ title: '提交管理员处理',
        description: '本次强制复检不通过，任务进入“待二次分配”。系统将还原机器初稿并删除旧标注修改内容，原操作者的质检统计保留。缺少初稿时由管理员处理。',
        label: '未通过原因（必填）', required: true, requiredMessage: '请填写具体问题。', maxLength: 1000,
        defaultValue: draft.current, confirmLabel: '提交管理员', cancelLabel: '继续核验' });
      if (note === null) return;
      draft.current = note;
      const path = `/api/control-plane/v1/${stage.toLowerCase()}-qa/items/${encodeURIComponent(itemId)}/escalate`;
      const payload = { note, expectedRevisionToken: revisionToken };
      const fingerprint = JSON.stringify({ path, payload });
      if (mutation.current?.fingerprint !== fingerprint) mutation.current = { fingerprint, requestId: createRequestId() };
      await apiRequest(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, requestId: mutation.current.requestId }) });
      draft.current = ''; notifyWorkspaceUpdated(); toast.success('已提交管理员，任务进入待二次分配。');
      await onCompleted();
    } catch (caught) { toast.error(caught instanceof Error ? caught.message : '提交失败，请重试。'); }
    finally { pending.current = false; setBusy(false); onBusyChange?.(false); }
  }
  return <Button unstyled className="button danger" disabled={disabled || busy || !revisionToken} onClick={() => void escalate()}>提交管理员</Button>;
}
