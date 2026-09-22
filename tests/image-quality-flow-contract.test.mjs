import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('image initial review, independent QA and delivery have non-overlapping role boundaries', async () => {
  const [server, imageQuality, editing, delivery, proxy, navigation, page, taskReview, imageQa, pendingEditsDialog] = await Promise.all([
    source('server/src/http-server.mjs'),
    source('server/src/image-quality-control.mjs'),
    source('server/src/image-editing.mjs'),
    source('server/src/final-delivery.mjs'),
    source('src/admin/proxy-policy.mjs'),
    source('app/components/side-nav.tsx'),
    source('app/image-qa/page.tsx'),
    source('app/workbench/task-review-dialog.tsx'),
    source('app/image-qa/image-qa-workbench.tsx'),
    source('app/components/pending-image-edits-dialog.tsx'),
  ]);

  assert.match(server, /router\.post\('\/v1\/tasks\/:taskId\/submit-image-self-review'[\s\S]{0,160}requestActor\(ctx, \['ADMIN', 'USER'\]\)/u);
  assert.match(server, /submit-image-self-review'[\s\S]{0,220}assertTaskAccess\(ctx, repository, \{ ownerOnly: true \}\)/u);
  assert.match(server, /router\.get\('\/v1\/image-qa\/items'[\s\S]{0,120}requestActor\(ctx, \['ADMIN', 'REVIEWER'\]\)/u);
  assert.match(server, /router\.post\('\/v1\/tasks\/:taskId\/review-images'[\s\S]{0,120}IMAGE_REVIEW_MOVED/u);
  assert.match(server, /router\.get\('\/v1\/delivery-pool'[\s\S]{0,120}requestActor\(ctx, \['ADMIN', 'USER'\]\)/u);
  assert.match(imageQuality, /task\.assigned_to_user_id !== actor\.username/u);
  assert.match(imageQuality, /normalizeActor\(rawActor, \['ADMIN', 'USER'\]\)/u);
  assert.match(imageQuality, /role IN \('ADMIN','USER'\)/u);
  assert.match(imageQuality, /actor\.role !== 'ADMIN'[\s\S]{0,120}submitter_account_id/u);
  assert.match(imageQuality, /jsonb_array_elements\(image_run\.result->'images'\)/u);
  assert.match(imageQuality, /page\.image->>'deliveryAssetId'[\s\S]{0,80}page\.image->>'assetId'/u,
    'image QA must expose only the final delivery asset bound to each logical page');
  assert.match(editing, /\['ADMIN','USER'\]/u);
  assert.match(editing, /t\.state IN \('MANUAL_ARCHIVE','IMAGE_REWORK_PENDING'\)/u);
  assert.match(delivery, /IMAGE_QA_NOT_RELEASED/u);
  assert.match(delivery, /IMAGE_EDITS_PENDING/u);
  assert.match(imageQuality, /assertNoPendingImageEdits\(client, \{ taskId, imageRunId \}\)/u);
  assert.match(imageQuality, /pending_image_edit_count/u);
  assert.match(taskReview, /pendingImageEdits\.length > 0/u);
  assert.match(taskReview, /<PendingImageEditsDialog/u);
  assert.match(pendingEditsDialog, /采用、拒绝或取消后再提交图片初审/u);
  assert.match(imageQa, /当前版本不能质检通过/u);
  assert.match(proxy, /url\.pathname === '\/image-qa'/u);
  assert.match(navigation, /href: '\/image-qa'/u);
  assert.match(navigation, /workflowNavigationHrefs\(session\)/u);
  assert.doesNotMatch(navigation.slice(navigation.indexOf(": navigationGroups.map", navigation.indexOf("role === 'REVIEWER'") + 20)), /'\/delivery-pool'/u);
  assert.match(page, /canQualityCheckImage\(session\)/u);
});

test('image sampling freezes batches and every returned image requires mandatory recheck', async () => {
  const [migration, imageQuality, settings] = await Promise.all([
    source('server/migrations/0055_image_quality_flow.sql'),
    source('server/src/image-quality-control.mjs'),
    source('app/settings/workflow-quality-settings-panel.tsx'),
  ]);

  assert.match(migration, /IMAGE_QC_PENDING/u);
  assert.match(migration, /IMAGE_REWORK_PENDING/u);
  assert.match(migration, /image_sampling_freezes/u);
  assert.match(migration, /image_sampling_remainders/u);
  assert.match(imageQuality, /IMAGE_BATCH_TAIL_MS = 30 \* 60 \* 1000/u);
  assert.match(imageQuality, /sample_kind[\s\S]{0,120}'MANDATORY_RECHECK'/u);
  assert.match(imageQuality, /mandatory_image_qc = true/u);
  assert.match(imageQuality, /mandatory_image_qc_origin = 'BATCH_RETURN'/u);
  assert.match(settings, /文案与图片使用独立抽检比例/u);
  assert.match(settings, /返修复检不受此比例影响，固定全检/u);
});

test('an enabled image-return reason switch cannot be saved without an option', async () => {
  const [normalizer, panel, quality] = await Promise.all([
    source('src/human-quality-settings.mjs'),
    source('app/settings/human-quality-settings-panel.tsx'),
    source('server/src/image-quality-control.mjs'),
  ]);

  assert.match(normalizer, /showDeductionReasons && settings\.imageReasons\.length === 0/u);
  assert.match(normalizer, /开启图片质检扣分原因时，必须至少填写一项图片扣分原因/u);
  assert.match(panel, /imageReasonsMissing/u);
  assert.match(panel, /当前原因列表为空，无法保存/u);
  assert.match(panel, /disabled=\{loading \|\| busy \|\| !complete \|\| imageReasonsMissing \|\| !hasChanges\}/u);
  assert.match(quality, /showDeductionReasons[\s\S]{0,120}imageReasons\.length > 0[\s\S]{0,100}reasonCodes\.length === 0/u);
});

test('image QA returns round-trip their target, labels, copy fields, problem images and instructions', async () => {
  const [quality, repository, taskReview, styles] = await Promise.all([
    source('server/src/image-quality-control.mjs'),
    source('server/src/postgres-repository.mjs'),
    source('app/workbench/task-review-dialog.tsx'),
    source('app/globals.css'),
  ]);

  assert.match(quality, /finalRework:[\s\S]{0,180}reasonSnapshots[\s\S]{0,120}copyFields[\s\S]{0,80}problemAssetIds/u);
  assert.match(quality, /details[\s\S]{0,180}reworkTarget[\s\S]{0,120}reasonSnapshots/u);
  assert.match(repository, /AS image_qa_return/u);
  assert.match(repository, /'target'[\s\S]{0,300}'reasonSnapshots'[\s\S]{0,300}'problemAssetIds'/u);
  assert.match(repository, /imageQaReturn: imageQaReturnFrom/u);
  assert.match(taskReview, /<dt>返工范围<\/dt>/u);
  assert.match(taskReview, /<dt>文案位置<\/dt>/u);
  assert.match(taskReview, /<dt>问题标签<\/dt>/u);
  assert.match(taskReview, /<dt>问题图片<\/dt>/u);
  assert.match(taskReview, /<dt>具体要求<\/dt>/u);
  assert.match(taskReview, /workbench-rework-problem-images/u);
  assert.match(styles, /workbench-image-review-thumbnail\[data-problem="true"\]/u);
});
