'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { apiRequest } from '../../components/api-client';

export function RetryButton({ taskId }: { taskId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function retry() {
    if (!window.confirm('确认把这个失败任务重新放回待处理队列？')) return;
    setBusy(true); setError('');
    try {
      await apiRequest(`/api/tasks/${taskId}/retry`, { method: 'POST' });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '重新入队失败');
    } finally { setBusy(false); }
  }
  return <><button className="button danger" disabled={busy} onClick={retry}>{busy ? '重新入队中…' : '重新入队'}</button>{error && <span className="pill pill-failed">{error}</span>}</>;
}
