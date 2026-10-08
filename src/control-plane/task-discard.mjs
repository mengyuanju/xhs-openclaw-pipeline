export function canAdminDiscardTask(task) {
  if (['COPY_QUEUED', 'IMAGE_QUEUED'].includes(task?.state)) return true;
  return task?.state === 'COPY_REVIEW_PENDING'
    && task.copyQaReworkPending !== true
    && task.mandatoryCopyQcOrigin !== 'QA_RETURN';
}
