import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createMockPost, buildDeliveryImageTaskPrompt } from '../src/pipeline.mjs';
import { createMockVisualPlan, parseVisualPlanOutput } from '../src/visual-plan.mjs';
import { generateVisualPlan } from '../src/visual-plan-generation.mjs';
import { visualPlanSchema } from '../src/visual-plan-schema.mjs';
import { normalizeStandaloneImageSource, reprocessStandaloneImages, convertStandaloneImageRun, readStandaloneImageFile, readStandaloneImageProgress } from '../src/standalone-image-generation.mjs';
import { renderDeliveryImages } from '../src/images.mjs';
import { discoverStandaloneRecoveryImages, stageRecoveryImages, writeImageCheckpoint } from '../src/standalone-image-recovery.mjs';
import { executeImageClaim } from '../src/executor/agent.mjs';

const source = () => { const post = createMockPost(3); return { query: '桌面整理', copy: { title: post.title, body: post.body, tags: post.tags }, imagePlan: post.imagePlan,
  imageSettings: { format: 'WEBP', background: 'SOLID', backgroundColor: '#112233' } }; };
const pixels = () => sharp({ create: { width: 1086, height: 1448, channels: 4, background: { r: 80, g: 120, b: 160, alpha: 0 } } }).png().toBuffer();
async function directory(t) { const dir = await mkdtemp(join(tmpdir(), 'xhs-image-controls-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('manual layouts survive source normalization, model schema, parse, prompt and transport fallback', async () => {
  const input = source(); input.imagePlan[0].layout = { mode: 'CUSTOM', titlePosition: 'bottom', imageShare: 70, direction: '右侧是主体，左侧安放文字' };
  input.imagePlan[1].layout = { mode: 'TEMPLATE', template: 'STEPS_RIGHT' };
  const post = normalizeStandaloneImageSource(input);
  const parsed = parseVisualPlanOutput(JSON.stringify(createMockVisualPlan(post)), { post });
  assert.equal(parsed.pages[0].layoutTemplate, 'CUSTOM');
  assert.equal(parsed.pages[0].manualLayout.titlePosition, 'bottom');
  assert.equal(parsed.pages[1].layoutTemplate, 'STEPS_RIGHT');
  assert.equal(visualPlanSchema(post).properties.pages.items.anyOf[0].properties.layoutTemplate.enum[0], 'CUSTOM');
  const prompt = buildDeliveryImageTaskPrompt({ post, plan: post.imagePlan[0], visualPage: parsed.pages[0], imageIndex: 1, imageCount: 3 });
  assert.match(prompt, /右侧是主体/); assert.match(prompt, /#112233/);
  const fallback = await generateVisualPlan({ post, allowTransportFallback: () => true, client: { runText() { throw new Error('offline'); } } });
  assert.equal(fallback.visualPlan.pages[0].manualLayout.titlePosition, 'bottom');
  assert.equal(fallback.visualPlan.pages[1].layoutTemplate, 'STEPS_RIGHT');
});

test('renderer validates decoded delivery pixels, preserves alpha sources and resumes all artifacts without model calls', async t => {
  const outputDir = await directory(t);
  const post = normalizeStandaloneImageSource(source());
  const bytes = await pixels(); let generated = 0; let checked = 0;
  const fake = { async runImage({ outputPath }) { generated++; await sharp(bytes).toFile(outputPath); return { outputPath, provider: 'fake-image-model', model: 'fake' }; } };
  fake.runImageEdit = fake.runImage;
  const images = await renderDeliveryImages({ post, outputDir, mock: false, openclaw: fake, textRenderingMode: 'model-native', imageConcurrency: 1,
    onImageCheckpoint: writeImageCheckpoint, onImageCompleted: options => writeImageCheckpoint({ ...options, completed: true }),
    validateImage: async ({ imagePath }) => {
      checked++; assert.equal((await sharp(imagePath).stats()).isOpaque, true);
      const deliveryPath = imagePath.replace(/\.png$/, '.webp');
      assert.deepEqual(await sharp(imagePath).raw().toBuffer(), await sharp(deliveryPath).raw().toBuffer());
      return { passed: true };
    } });
  assert.equal(generated, 3); assert.equal(checked, 3);
  assert.ok(images.every(image => image.transparency.source && !image.transparency.delivery));
  const recoveries = await discoverStandaloneRecoveryImages({ outputDir, post });
  const nextDir = join(outputDir, 'next'); await mkdir(nextDir);
  await stageRecoveryImages({ images: recoveries, outputDir: nextDir });
  const resumed = await renderDeliveryImages({ post, outputDir: nextDir, mock: false, openclaw: { runImage() { assert.fail('must not call a model'); } }, recoveryImages: recoveries });
  assert.ok(resumed.every(image => image.deliveryFile.endsWith('.webp') && image.transparency.source));
  assert.equal((await sharp(join(nextDir, resumed[0].sourceFile)).stats()).isOpaque, false);
});

test('local conversions are independent immutable versions and can undo a solid fill using retained alpha', async t => {
  const outputRoot = await directory(t); const input = source(); const bytes = await pixels();
  const originalResult = { runId: randomUUID(), images: input.imagePlan.map((page, index) => ({ pageIndex: index + 1, kind: page.kind, file: `0${index + 1}-${page.kind}.png`, provider: 'original-image-model', model: 'original-model', layout: null })) };
  const first = await reprocessStandaloneImages({ source: input, originalResult, loadSource: async () => bytes, outputRoot });
  const second = await convertStandaloneImageRun({ outputRoot, sourceRunId: first.runId, imageSettings: { format: 'PNG', background: 'TRANSPARENT' } });
  assert.notEqual(second.runId, first.runId);
  assert.equal(second.processing.sourceRunId, first.runId);
  assert.equal(second.images[0].provider, 'original-image-model');
  assert.equal(second.images[0].transparency.delivery, true);
  const current = await readStandaloneImageProgress({ outputRoot, runId: second.runId });
  assert.equal(current.result.processing.type, 'LOCAL');
  assert.equal(current.result.qc.passed, false);
  const old = await readStandaloneImageFile({ outputRoot, runId: first.runId, file: first.images[0].deliveryFile });
  assert.equal(old.mediaType, 'image/webp');
  assert.equal((await sharp(old.content).stats()).isOpaque, true);
  await assert.rejects(readStandaloneImageFile({ outputRoot, runId: first.runId, file: '../source.json' }));
});

test('executor conversion downloads pinned sources and uploads distinct preview, source and delivery with zero model calls', async t => {
  const workRoot = await directory(t); const input = source(); const bytes = await pixels(); const executionId = randomUUID();
  const originalResult = { runId: randomUUID(), images: input.imagePlan.map((page, index) => ({ pageIndex: index + 1, kind: page.kind, file: `0${index + 1}-${page.kind}.png`, provider: 'original', model: 'original-model', layout: null })) };
  const uploaded = []; let completed;
  await executeImageClaim({ workRoot, claim: { task: { id: 17 }, execution: { id: executionId, snapshot: { task: { query: input.query }, copyRevision: { content: { ...input,
    imageReprocess: { originalResult, sources: [1, 2, 3].map(assetId => ({ assetId, originalAvailable: true, sha256: createHash('sha256').update(bytes).digest('hex') })) } } } } } },
    imageClient: new Proxy({}, { get() { assert.fail('conversion must not create or invoke a model client'); } }),
    controlPlane: { updateProgress: async () => {}, downloadImageSource: async (id, assetId) => { assert.equal(id, executionId); assert.ok([1, 2, 3].includes(assetId)); return bytes; },
      uploadAsset: async (_id, asset) => { uploaded.push(asset); return { id: uploaded.length + 100, url: `/v1/assets/${uploaded.length + 100}`, imageRunId: executionId }; },
      completeImage: async (_id, result) => { completed = result; return { state: 'MANUAL_ARCHIVE' }; } } });
  assert.equal(uploaded.length, 9);
  assert.equal(uploaded.filter(asset => asset.mediaType === 'image/webp').length, 3);
  assert.ok(completed.images.every(image => image.assetId !== image.sourceAssetId && image.deliveryAssetId !== image.assetId && image.sourceUrl.startsWith('/v1/assets/')));
  assert.equal(completed.processing.type, 'LOCAL');
});
