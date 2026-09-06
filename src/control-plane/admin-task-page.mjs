/**
 * Read a complete server page; old centers must not silently ignore admin filters.
 * @param {(path: string) => Promise<any>} request
 * @param {{createdByUserId?: string, createdByRole?: string, state?: string, query?: string, limit?: number, offset?: number}} options
 */
export async function loadAdminTaskPage(request, {
  createdByUserId, createdByRole, state, query, limit = 20, offset = 0,
} = {}) {
  const health = await request('/api/control-plane/health');
  if (health?.capabilities?.adminTaskFilters !== true) {
    throw new Error('请更新并重启中心服务，以支持全部作业和角色筛选。');
  }
  const search = new URLSearchParams({ limit: String(limit), offset: String(offset), includeTotal: 'true' });
  if (createdByUserId) search.set('createdByUserId', createdByUserId);
  if (createdByRole) search.set('createdByRole', createdByRole);
  if (state) search.set('state', state);
  if (query) search.set('query', query);
  const page = await request(`/api/control-plane/v1/tasks?${search}`);
  if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0
    || page.limit !== limit || page.offset !== offset || page.items.length > limit) {
    throw new Error('中心服务返回的分页数据无效，请更新中心服务后重试。');
  }
  return page;
}
