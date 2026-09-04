export const IMAGE_RETRY_EXHAUSTED_LABEL = '生图3次失败';

/** @param {{ state: string, currentStage: string | null }} task */
export function isImageRetryExhausted(task) {
  return task.state === 'COPY_REVIEW_PENDING' && task.currentStage === 'IMAGE_RETRY_EXHAUSTED';
}
