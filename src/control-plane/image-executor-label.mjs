/** @param {{state: string, imageExecutorNodeId?: string | null, imageExecutorNodeName?: string | null}} task */
export function imageExecutorLabel(task) {
  if (task.state === 'IMAGE_QUEUED') return '待领取';
  return task.imageExecutorNodeName || task.imageExecutorNodeId || '执行机信息不可用';
}
