/**
 * @typedef {{username: string, displayName: string, role: string, status: string}} JobCreator
 * @param {(path: string) => Promise<unknown>} request
 * @returns {Promise<JobCreator[]>}
 */
export async function loadJobCreators(request) {
  const users = await request('/api/control-plane/v1/users');
  if (!Array.isArray(users) || users.some((user) => !user
    || ['username', 'displayName', 'role', 'status'].some((key) => typeof user[key] !== 'string' || !user[key].trim()))) {
    throw new Error('中心服务返回的作业员数据无效，请重试或更新中心服务。');
  }
  return users;
}
