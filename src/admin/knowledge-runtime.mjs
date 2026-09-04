import { createControlPlaneClient, ControlPlaneApiError } from '../control-plane/client.mjs';
import { ApiError } from './http.mjs';
import { withAdminStore } from './runtime.mjs';
import { createRemoteKnowledgeStore } from './remote-knowledge-store.mjs';

export async function readKnowledgeModelApi(store) {
  const { settings } = await store.getProductionSettings();
  return settings.modelApi;
}

export async function withKnowledgeStore(action) {
  if (!process.env.CONTROL_PLANE_URL?.trim()) return withAdminStore(action);
  try {
    return await action(createRemoteKnowledgeStore(createControlPlaneClient({ baseUrl: process.env.CONTROL_PLANE_URL })));
  } catch (error) {
    if (error instanceof ControlPlaneApiError) {
      throw new ApiError(error.status, error.code, error.status === 404
        ? '中心服务尚未提供此知识库接口，请更新并重启 server 后重试' : error.message);
    }
    if (error instanceof TypeError && error.message === 'fetch failed') {
      throw new ApiError(503, 'CONTROL_PLANE_UNAVAILABLE', '无法连接远端中心服务，请稍后重试');
    }
    throw error;
  }
}

export async function listAllKnowledge(store, method) {
  const items = [];
  for (let page = 1; ; page++) {
    const result = await store[method]({ page, pageSize: 100 });
    items.push(...result.data);
    if (page >= result.pagination.totalPages) return items;
  }
}
