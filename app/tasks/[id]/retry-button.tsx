'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';

import { apiRequest } from '../../components/api-client';

export function RetryButton({ taskId }: { taskId: number }) {
  const router = useRouter();
  const confirm = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function retry() {
    if (!await confirm({
      title: '重新入队？',
      description: '这个失败任务会回到待处理队列，并按当前固定配置重新执行。',
      confirmLabel: '确认重新入队',
    })) return;
    setBusy(true); setError('');
    try {
      await apiRequest(`/api/tasks/${taskId}/retry`, { method: 'POST' });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '重新入队失败');
    } finally { setBusy(false); }
  }
  return <><button className="button danger" type="button" disabled={busy} onClick={retry}>{busy ? '重新入队中…' : '重新入队'}</button>{error && <span className="pill pill-failed" role="alert">{error}</span>}</>;
}
