/**
 * Read a complete server page; old centers must not silently ignore admin filters.
 * @param {(path: string) => Promise<any>} request
 * @param {{createdByUserId?: string, createdByRole?: string, state?: string, query?: string, deduplicateQuery?: boolean, limit?: number, offset?: number}} options
 */
export async function loadAdminTaskPage(request, {
  createdByUserId, createdByRole, state, query, deduplicateQuery = false, limit = 20, offset = 0,
} = {}) {
  const search = new URLSearchParams({ limit: String(limit), offset: String(offset), includeTotal: 'true' });
  if (createdByUserId) search.set('createdByUserId', createdByUserId);
  if (createdByRole) search.set('createdByRole', createdByRole);
  if (state) search.set('state', state);
  if (query) search.set('query', query);
  if (deduplicateQuery) search.set('deduplicateQuery', 'true');
  const healthRequest = request('/api/control-plane/health');
  // Start both reads together, but keep the capability gate authoritative.
  // Observe task rejection immediately, even when health fails first.
  const pageRequest = request(`/api/control-plane/v1/tasks?${search}`).then(
    (page) => ({ page }), (error) => ({ error }),
  );
  const health = await healthRequest;
  if (health?.capabilities?.adminTaskFilters !== true) {
    throw new Error('请更新并重启中心服务，以支持全部作业和角色筛选。');
  }
  const result = await pageRequest;
  if ('error' in result) throw result.error;
  const page = result.page;
  if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0
    || page.limit !== limit || page.offset !== offset || page.items.length > limit) {
    throw new Error('中心服务返回的分页数据无效，请更新中心服务后重试。');
  }
  return page;
}
