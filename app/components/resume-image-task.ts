import { apiRequest } from './api-client';

export async function resumeImageTask(taskId: number) {
  const health = await apiRequest<{ capabilities?: { imageResume?: boolean } }>('/api/control-plane/health');
  if (!health?.capabilities?.imageResume) {
    throw new Error('中心服务尚未支持断点续跑，请先更新并重启中心服务。任务未重新入队。');
  }
  return apiRequest(`/api/control-plane/v1/tasks/${taskId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ useLatestConfig: false }),
  });
}
