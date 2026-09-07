import { apiRequest } from './api-client';
import { requestImageResume } from '../../src/control-plane/image-resume.mjs';

export async function resumeImageTask(taskId: number) {
  return requestImageResume(apiRequest, taskId);
}
