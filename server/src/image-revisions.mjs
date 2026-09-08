import { ControlPlaneConflictError, ControlPlaneNotFoundError, normalizeNodeId, normalizeTaskId, normalizeUuid } from './domain.mjs';
import { normalizeImageSettings, normalizePageLayout } from './image-options.mjs';

export function assertImageResultSettings(content, result) {
  if (!content?.imageSettings && !content?.imagePlan?.some(page => page.layout)) return;
  const expected = content.imageSettings && normalizeImageSettings(content.imageSettings);
  const actual = result.imageSettings && normalizeImageSettings(result.imageSettings);
  if (result.imageControlsVersion !== 1 || JSON.stringify(actual) !== JSON.stringify(expected)
    || !Array.isArray(result.images) || result.images.length !== content.imagePlan?.length
    || (expected && result.images.some(image => !image?.imageSettings || JSON.stringify(normalizeImageSettings(image.imageSettings)) !== JSON.stringify(expected)
      || !Number.isSafeInteger(image.sourceAssetId) || !Number.isSafeInteger(image.deliveryAssetId)))) {
    throw new ControlPlaneConflictError('IMAGE_CONTROLS_RESULT_MISMATCH', '执行机返回的图片配置或资产不完整，请更新执行机后重新处理');
  }
}

export async function reviseTaskImages(client, rawTaskId, input, actorUsername, actorRole = 'ADMIN') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('图片修改参数无效');
  for (const key of Object.keys(input)) if (!['revisionId', 'imageRunId', 'nodeId', 'operation', 'imageSettings', 'layouts', 'confirmation'].includes(key)) throw new TypeError(`未知图片修改参数 ${key}`);
  const taskId = normalizeTaskId(rawTaskId);
  const revisionId = normalizeTaskId(input.revisionId);
  const imageRunId = input.imageRunId == null ? null : normalizeUuid(input.imageRunId, 'imageRunId');
  const nodeId = normalizeNodeId(input.nodeId);
  if (!['REGENERATE', 'REPROCESS'].includes(input.operation)) throw new TypeError('图片修改 operation 无效');
  if (input.operation === 'REGENERATE' && input.confirmation !== 'LIVE_IMAGE_COST_ACCEPTED') throw new TypeError('重新生图需要确认模型费用');
  const imageSettings = normalizeImageSettings(input.imageSettings);
  const task = (await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [taskId])).rows[0];
  if (!task) throw new ControlPlaneNotFoundError('task not found');
  if (!['MANUAL_ARCHIVE', 'REVIEWED', 'IMAGE_FAILED', 'IMAGE_QUEUED'].includes(task.state) || task.current_execution_id) throw new ControlPlaneConflictError('INVALID_TASK_STATE', '请等待当前图片执行结束后修改');
  if (Number(task.current_copy_revision_id) !== revisionId || (task.current_image_run_id ?? null) !== imageRunId) throw new ControlPlaneConflictError('STALE_IMAGE_REVISION', '图片或文案版本已更新，请刷新后重新修改');
  const revision = (await client.query('SELECT * FROM copy_revisions WHERE id = $1 AND task_id = $2 FOR UPDATE', [revisionId, taskId])).rows[0];
  if (!revision?.approved_at) throw new ControlPlaneConflictError('COPY_NOT_APPROVED', '请先审核文案');
  const original = revision.content;
  const plan = original.imagePlan ?? original.reviewed?.imagePlan ?? original.post?.imagePlan;
  if (!Array.isArray(plan) || plan.length < 3 || plan.length > 5) throw new TypeError('图片计划不完整');
  const requestedLayouts = actorRole === 'ADMIN' ? input.layouts : plan.map(() => ({ mode: 'AUTO' }));
  if (requestedLayouts !== undefined && (!Array.isArray(requestedLayouts) || requestedLayouts.length !== plan.length)) throw new TypeError('每页布局数量必须与图片计划一致');
  const imagePlan = plan.map((page, index) => requestedLayouts === undefined ? { ...page } : { ...page, layout: normalizePageLayout(requestedLayouts[index], page.kind) });
  const previousLayouts = plan.map(page => normalizePageLayout(page.layout ?? { mode: 'AUTO' }, page.kind));
  const nextLayouts = imagePlan.map(page => normalizePageLayout(page.layout ?? { mode: 'AUTO' }, page.kind));
  const content = { ...original, imagePlan, imageSettings,
    imageRevision: { version: 1, operation: input.operation, baseRevisionId: revisionId, baseImageRunId: imageRunId, actorUsername, createdAt: new Date().toISOString() } };
  delete content.imageReprocess;
  if (input.operation === 'REPROCESS') {
    if (JSON.stringify(previousLayouts) !== JSON.stringify(nextLayouts)) throw new TypeError('修改布局必须重新生图，格式转换不能改变构图');
    if (!imageRunId) throw new TypeError('没有可转换的图片版本');
    const run = (await client.query('SELECT * FROM image_runs WHERE id = $1 AND task_id = $2', [imageRunId, taskId])).rows[0];
    if (!Array.isArray(run?.result?.images) || run.result.images.length !== plan.length) throw new TypeError('原图片版本未完成');
    const assets = (await client.query('SELECT id, sha256, media_type FROM assets WHERE task_id = $1 AND image_run_id = $2', [taskId, imageRunId])).rows;
    const sources = run.result.images.map(image => {
      const assetId = image.sourceAssetId ?? image.assetId;
      const asset = assets.find(item => Number(item.id) === assetId && item.media_type === 'image/png');
      if (!asset || !/^[a-f0-9]{64}$/u.test(asset.sha256)) throw new TypeError('源图不属于当前任务图片版本或数据不完整');
      return { assetId, sha256: asset.sha256, originalAvailable: Boolean(image.sourceAssetId) && image.sourceOriginal !== false };
    });
    content.imageReprocess = { version: 1, sourceRunId: imageRunId, sources, originalResult: run.result };
  }
  const revisionNumber = Number((await client.query('SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM copy_revisions WHERE task_id = $1', [taskId])).rows[0].revision);
  const saved = (await client.query(`INSERT INTO copy_revisions(task_id, execution_id, revision, content, approved_at, approved_by_node_id)
    VALUES ($1, NULL, $2, $3, now(), $4) RETURNING *`, [taskId, revisionNumber, content, nodeId])).rows[0];
  return (await client.query(`UPDATE tasks SET state = 'IMAGE_QUEUED', current_copy_revision_id = $2,
    current_image_run_id = NULL, current_execution_id = NULL, current_stage = 'IMAGE_QUEUED',
    progress_percent = 0, progress_message = '图片配置已保存，等待图片执行机处理', pending_snapshot = NULL,
    image_reviewed_at = NULL, image_reviewed_by_user_id = NULL, execution_started_at = NULL,
    last_activity_at = now(), finished_at = NULL, error = NULL, updated_at = now()
    WHERE id = $1 RETURNING *`, [taskId, Number(saved.id)])).rows[0];
}
