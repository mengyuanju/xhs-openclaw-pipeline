import { apiRequest, ApiRequestError } from './api-client';
import { browserSessionGeneration } from './session-client';
import { createImageEditStateReader, imageEditStateSignature } from '../../src/image-edit-state-cache.mjs';

export type ImageEditStateItem = { id: string; task_id: number; target_page: number; status: string; version: number;
  error?: string | null; created_by?: string; created_by_account_id?: number | null };
export type ImageEditState = { status: string; signature: string; items: ImageEditStateItem[];
  legacy?: boolean; legacyItems?: unknown[] };
export type ImageEditStateQuery = { taskId: number; standalone?: boolean; ids?: string[]; fresh?: boolean };

async function read(query: ImageEditStateQuery): Promise<ImageEditState> {
  const base = query.standalone ? `/v1/image-editor/workspaces/${query.taskId}` : `/v1/tasks/${query.taskId}`;
  const parameters = query.ids?.length ? `?ids=${encodeURIComponent(query.ids.join(','))}` : '';
  try {
    const state = await apiRequest<ImageEditState>(`/api/control-plane${base}/image-edits/state${parameters}`, {cache:'no-store',signal:AbortSignal.timeout(15_000)});
    if (Array.isArray(state)) return legacy(state, base, query);
    if (!state || !Array.isArray(state.items) || typeof state.signature !== 'string') throw new Error('图片修改状态数据不完整');
    return state;
  } catch (error) {
    if (!(error instanceof ApiRequestError) || error.status !== 404) throw error;
    // Rolling upgrades can briefly serve an older center. Share the legacy full response
    // with the panel rather than fetching that same history again in this polling turn.
    const history = await apiRequest<ImageEditStateItem[]>(`/api/control-plane${base}/image-edits`, {cache:'no-store',signal:AbortSignal.timeout(15_000)});
    return legacy(history, base, query);
  }
}

async function legacy(history: ImageEditStateItem[], base: string, query: ImageEditStateQuery): Promise<ImageEditState> {
  if (!Array.isArray(history)) throw new Error('图片修改历史数据不完整');
  const requested = [...new Set(query.ids ?? [])].filter(id => !history.some(item => item.id === id));
  const recovered = await Promise.all(requested.map(async id => {
    const path = query.standalone ? `/v1/image-editor/edits/${encodeURIComponent(id)}` : `/v1/image-edits/${encodeURIComponent(id)}`;
    try { return await apiRequest<ImageEditStateItem>(`/api/control-plane${path}`, {cache:'no-store',signal:AbortSignal.timeout(15_000)}); }
    catch(error) { if(error instanceof ApiRequestError && error.status === 404)return null; throw error; }
  }));
  const items = [...history, ...recovered.filter((item): item is ImageEditStateItem => item !== null)];
  const status = query.standalone
    ? (await apiRequest<{status:string}>(`/api/control-plane${base}`, {cache:'no-store',signal:AbortSignal.timeout(15_000)})).status
    : history.find(item => item.status === 'RUNNING')?.status ?? history.find(item => item.status === 'QUEUED')?.status ?? history[0]?.status ?? 'UPLOADED';
  return { status, signature: imageEditStateSignature(items), items, legacy: true, legacyItems: history };
}

export const readImageEditState: (query: ImageEditStateQuery) => Promise<ImageEditState> = createImageEditStateReader({
  read, scope: browserSessionGeneration,
});
