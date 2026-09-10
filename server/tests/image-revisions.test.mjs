import test from 'node:test';
import assert from 'node:assert/strict';
import { assertImageResultSettings, reviseTaskImages } from '../src/image-revisions.mjs';
import { normalizeImageSettings } from '../src/image-options.mjs';

test('completion refuses silently ignored formats and missing source or delivery references', () => {
  const imageSettings = normalizeImageSettings({ format: 'WEBP' });
  const content = { imageSettings, imagePlan: [{}, {}, {}] };
  const result = { imageControlsVersion: 1, imageSettings, images: [1, 2, 3].map(id => ({ imageSettings, sourceAssetId: id, deliveryAssetId: id + 3 })) };
  assert.doesNotThrow(() => assertImageResultSettings(content, result));
  assert.throws(() => assertImageResultSettings(content, { ...result, imageControlsVersion: undefined }), { code: 'IMAGE_CONTROLS_RESULT_MISMATCH' });
  assert.throws(() => assertImageResultSettings(content, { ...result, imageSettings: { format: 'PNG' } }), { code: 'IMAGE_CONTROLS_RESULT_MISMATCH' });
  delete result.images[0].sourceAssetId;
  assert.throws(() => assertImageResultSettings(content, result), { code: 'IMAGE_CONTROLS_RESULT_MISMATCH' });
});

const runId = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const task = { id: 1, state: 'MANUAL_ARCHIVE', current_copy_revision_id: 4, current_image_run_id: runId };
  const content = { copy: { title: '已审核标题', body: '已审核正文', tags: ['#标签'] }, imagePlan: ['hero', 'steps', 'summary'].map(kind => ({ kind, prompt: '保留画面内容' })) };
  const result = { images: content.imagePlan.map((p, index) => ({ file: `0${index + 1}-${p.kind}.png`, assetId: index + 10, provider: 'original-model' })) };
  const calls = [];
  const client = { async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes('SELECT * FROM tasks')) return { rows: [task] };
    if (sql.includes('SELECT * FROM copy_revisions')) return { rows: [{ id: 4, content, approved_at: 'now' }] };
    if (sql.includes('SELECT * FROM image_runs')) return { rows: [{ id: runId, result }] };
    if (sql.includes('SELECT id, sha256')) return { rows: [10, 11, 12].map(id => ({ id, sha256: 'a'.repeat(64), media_type: 'image/png' })) };
    if (sql.includes('MAX(revision)')) return { rows: [{ revision: 3 }] };
    if (sql.includes('INSERT INTO copy_revisions')) return { rows: [{ id: 5 }] };
    if (sql.includes('UPDATE delivery_entries')) return { rows: [] };
    if (sql.includes('UPDATE tasks')) return { rows: [{ ...task, state: 'IMAGE_QUEUED' }] };
    throw new Error(sql);
  } };
  return { client, task, content, result, calls };
}
const input = { revisionId: 4, imageRunId: runId, nodeId: 'operator', operation: 'REPROCESS', imageSettings: { format: 'WEBP' } };

test('local conversion pins source assets and creates an approved revision without rewriting copy or mutating old images', async () => {
  const f = fixture();
  const original = JSON.stringify(f.content);
  await reviseTaskImages(f.client, 1, input, 'alice');
  const saved = f.calls.find(c => c.sql.includes('INSERT INTO copy_revisions')).values[2];
  assert.deepEqual(saved.copy, f.content.copy);
  assert.equal(saved.imageSettings.format, 'WEBP');
  assert.deepEqual(saved.imageReprocess.sources.map(s => s.assetId), [10, 11, 12]);
  assert.equal(saved.imageReprocess.originalResult.images[0].provider, 'original-model');
  assert.equal(JSON.stringify(f.content), original);
  assert.equal(f.calls.some(c => /UPDATE image_runs|DELETE/.test(c.sql)), false);
});

test('stale revision, stale image version, active generation and unsupported model confirmation fail before mutation', async () => {
  for (const patch of [{ revisionId: 3 }, { imageRunId: '22222222-2222-4222-8222-222222222222' }, { operation: 'REGENERATE' }]) {
    const f = fixture();
    await assert.rejects(reviseTaskImages(f.client, 1, { ...input, ...patch }, 'alice'));
    assert.equal(f.calls.some(c => /^\s*(INSERT|UPDATE)/.test(c.sql)), false);
  }
  const f = fixture(); f.task.state = 'IMAGE_RUNNING';
  await assert.rejects(reviseTaskImages(f.client, 1, input, 'alice'), { code: 'INVALID_TASK_STATE' });
});

test('reprocessing cannot change layout or reference an asset outside this task and run', async () => {
  const f = fixture();
  await assert.rejects(reviseTaskImages(f.client, 1, { ...input, layouts: [{ mode: 'CUSTOM' }, { mode: 'AUTO' }, { mode: 'AUTO' }] }, 'alice'), /布局/);
  f.result.images[0].sourceAssetId = 999;
  await assert.rejects(reviseTaskImages(f.client, 1, input, 'alice'), /源图/);
});

test('non-admin regeneration forces every inherited or submitted layout back to automatic', async () => {
  const f = fixture();
  f.content.imagePlan = f.content.imagePlan.map((page, index) => ({
    ...page,
    layout: index === 0 ? { mode: 'TEMPLATE', template: 'HERO_LEFT' } : { mode: 'CUSTOM' },
  }));
  await reviseTaskImages(f.client, 1, {
    ...input,
    operation: 'REGENERATE',
    confirmation: 'LIVE_IMAGE_COST_ACCEPTED',
    layouts: f.content.imagePlan.map(page => page.layout),
  }, 'alice', 'USER');
  const saved = f.calls.find(c => c.sql.includes('INSERT INTO copy_revisions')).values[2];
  assert.deepEqual(saved.imagePlan.map(page => page.layout), [
    { mode: 'AUTO' },
    { mode: 'AUTO' },
    { mode: 'AUTO' },
  ]);
});
