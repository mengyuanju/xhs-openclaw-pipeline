import { workModeKinds } from '../../src/admin/workflow-access.mjs';
import { ControlPlaneAuthenticationError, ControlPlaneAuthorizationError, normalizeTaskId, normalizeUuid } from './domain.mjs';

export const WORK_MODE_STATES = Object.freeze({ COPY: ['COPY_REVIEW_PENDING'], IMAGE: ['MANUAL_ARCHIVE', 'IMAGE_REWORK_PENDING'] });

function pageInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new TypeError('作业分页参数无效');
  return Number(value);
}

// Derive pending work from the existing workflow and stable account identity.
export async function loadWorkModePage(repository, options, actor) {
  const user = await repository.getUserByUsername(actor.username);
  if (!user || user.id !== actor.userId || user.role !== actor.role || user.status !== 'ACTIVE'
      || user.credentialVersion !== actor.credentialVersion) throw new ControlPlaneAuthenticationError();
  const kinds = workModeKinds({ ...user, roles: [user.role] });
  const kind = options.kind ?? kinds[0];
  if (!['COPY', 'IMAGE', 'COPY_QA', 'IMAGE_QA'].includes(kind)) throw new TypeError('请选择有效的作业类型');
  if (!kinds.includes(kind)) throw new ControlPlaneAuthorizationError('当前账号没有此作业权限');
  const itemId = options.itemId === undefined ? undefined : WORK_MODE_STATES[kind]
    ? normalizeTaskId(options.itemId) : normalizeUuid(options.itemId, 'itemId');
  const limit = pageInteger(options.limit, 50, 100), offset = pageInteger(options.offset, 0, 1_000_000);
  if (limit < 1) throw new TypeError('作业分页条数必须大于零');
  if (WORK_MODE_STATES[kind]) {
    const page = await repository.listTasks({
      states: WORK_MODE_STATES[kind].join(','),
      assignedToUserId: actor.username, assignedToAccountId: actor.userId,
      excludeActiveBlindQa: actor.role === 'REVIEWER', workModeKind: kind,
      sortBy: 'priority', sortOrder: 'desc', includeTotal: true, limit, offset,
      ...(itemId === undefined ? {} : { taskId: itemId }),
    });
    return { kind, kinds, total: page.total, hasMore: offset + page.items.length < page.total,
      items: page.items.map(task => ({ id: String(task.id), kind, taskId: task.id, label: task.query,
        source: task.sourceQueryPackageName ?? null,
        rework: task.mandatoryCopyQc === true || task.state === 'IMAGE_REWORK_PENDING', state: task.state,
        version: kind === 'COPY' ? task.currentCopyRevisionId : task.currentImageRunId })) };
  }
  const query = { status: 'PENDING', actionableOnly: true, limit: limit + 1, offset,
    ...(itemId === undefined ? {} : { itemPublicId: itemId }) };
  const rows = kind === 'COPY_QA' ? await repository.listCopyQaItems(query, { actor })
    : (await repository.listImageQaItems(query, { actor })).items;
  const hasMore = rows.length > limit;
  return { kind, kinds, total: hasMore ? null : offset + rows.length, hasMore,
    items: rows.slice(0, limit).map(item => ({ id: item.id, kind, label: item.anonymousCode,
      source: item.blindReview ? null : item.productionBatch?.queryPackageName ?? null,
      rework: item.sampleKind === 'MANDATORY_RECHECK', qa: item })) };
}
