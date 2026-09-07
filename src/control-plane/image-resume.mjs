/** Resume only a stopped image execution; running work and exhausted review cycles stay explicit. */
export function canResumeImageTask(task) {
  return task?.state === 'IMAGE_FAILED'
    && Number.isSafeInteger(task.currentCopyRevisionId) && task.currentCopyRevisionId > 0
    && !task.currentExecutionId;
}

export async function requestImageResume(request, taskId) {
  if (!Number.isSafeInteger(taskId) || taskId <= 0) throw new TypeError('任务 ID 无效');
  const health = await request('/api/control-plane/health');
  if (health?.capabilities?.imageResume !== true) {
    throw new Error('中心服务尚未支持断点续跑，请先更新并重启中心服务。任务未重新入队。');
  }
  return request(`/api/control-plane/v1/tasks/${taskId}/retry`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ useLatestConfig: false }),
  });
}
