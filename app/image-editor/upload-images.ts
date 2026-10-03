'use client';

import { apiRequest, ApiRequestError } from '../components/api-client';
import { browserSessionGeneration } from '../components/session-client';

type Upload = { index: number; token: string };
const base = '/api/control-plane/v1/image-editor';

function encodedFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
}

export async function uploadEditorImages<T>(files: File[], { requestId, title, onProgress }: {
  requestId: string; title: string; onProgress: (completed: number, total: number) => void;
}): Promise<T> {
  const generation = browserSessionGeneration();
  let binary = false;
  try { binary = (await apiRequest<{ binaryUploadVersion?: number } | null>(`${base}/limits`))?.binaryUploadVersion === 1; }
  catch (error) { if (!(error instanceof ApiRequestError && error.status === 404)) throw error; }
  const assertSession = () => { if (generation !== browserSessionGeneration()) throw new Error('账号已变化，请重新上传'); };
  assertSession();
  if (!binary) {
    const images = [];
    for (const file of files) {
      images.push({ mediaType: file.type, base64: await encodedFile(file) });
      assertSession();
      onProgress(images.length, files.length);
    }
    const result = await apiRequest<T>(`${base}/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, title, images }) });
    assertSession(); return result;
  }
  const controller = new AbortController();
  const uploads: Upload[] = new Array(files.length);
  let next = 0, completed = 0;
  const worker = async () => {
    while (next < files.length && !controller.signal.aborted) {
      const index = next++;
      try {
        if (generation !== browserSessionGeneration()) throw new Error('账号已变化，请重新上传');
        uploads[index] = await apiRequest<Upload>(`${base}/uploads/${requestId}/${index + 1}`, {
          method: 'POST', headers: { 'Content-Type': files[index].type }, body: files[index], signal: controller.signal,
        });
        assertSession();
        onProgress(++completed, files.length);
      } catch (error) { controller.abort(error); throw error; }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(2, files.length) }, worker));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed || generation !== browserSessionGeneration()) {
    if (generation === browserSessionGeneration()) await apiRequest(`${base}/uploads/${requestId}`, { method: 'DELETE' }).catch(() => {});
    throw failed?.reason ?? new Error('账号已变化，请重新上传');
  }
  const commit = () => apiRequest<T>(`${base}/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, title, uploads }) });
  const complete = async () => { const result = await commit(); assertSession(); return result; };
  try { return await complete(); }
  catch (error) {
    // Replaying the same manifest also recovers a committed response lost in transit.
    if (generation === browserSessionGeneration() && (error instanceof TypeError || error instanceof ApiRequestError && error.status >= 500)) return complete();
    throw error;
  }
}
