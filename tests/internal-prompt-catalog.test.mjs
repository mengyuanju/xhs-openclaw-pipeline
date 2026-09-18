import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROMPT_CATALOG, promptTemplatesForEditing } from '../src/prompt-catalog.mjs';
import { INTERNAL_PROMPT_CATALOG } from '../src/internal-prompt-catalog.mjs';
import { createPromptRuntime, withPromptRuntime, internalPrompt, defaultBusinessPrompt, promptProvenance } from '../src/prompt-runtime.mjs';
import { assertPromptEditable, normalizePromptContent } from '../src/admin/prompt-service.mjs';
import { previewPrompt } from '../src/admin/prompt-preview.mjs';
import { imageControlsPrompt } from '../src/image-layout-controls.mjs';
import { buildReviewImagePlanPrompt } from '../src/review-image-plan-generation.mjs';
import { withPromptTraceContext, requestPromptProvenance } from '../src/prompt-trace-context.mjs';
import { analyzeAndSaveExcellentCopy } from '../server/src/deepseek-copy-analysis.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { normalizeEdit } from '../server/src/image-editing.mjs';
import { processImageEdit } from '../server/src/image-edit-renderer.mjs';

test('every catalog item documents its purpose and every extracted template is the actual callable default', () => {
  assert.equal(new Set(PROMPT_CATALOG.map(item => item.kind)).size, PROMPT_CATALOG.length);
  for (const entry of PROMPT_CATALOG) {
    assert.ok(entry.group && entry.description && entry.usage, entry.kind);
    assert.ok(entry.callSites?.length || entry.executionStatus === 'RESERVED', entry.kind);
    assert.ok(defaultBusinessPrompt(entry.kind).trim(), entry.kind);
  }
  for (const entry of INTERNAL_PROMPT_CATALOG) {
    const content = defaultBusinessPrompt(entry.kind);
    const values = Object.fromEntries(entry.variables.map(item => [item.name, `value-${item.name}`]));
    const expected = content.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu,
      (original, name) => values[name] ?? original);
    assert.equal(internalPrompt(entry.kind, values), expected, entry.kind);
    for (const site of entry.callSites) {
      const file = site.split('#')[0];
      assert.ok(readFileSync(file, 'utf8').includes(`'${entry.kind}'`), site);
    }
    if (entry.editable) assertPromptEditable(entry.kind, normalizePromptContent(content));
  }
});

test('saved draft-only templates retain their actual default and are never mistaken for published rules', () => {
  const entry = PROMPT_CATALOG.find(item => item.kind === 'INTERNAL_IMAGE_MANUAL_LAYOUT');
  const catalog = [{ ...entry, candidate: defaultBusinessPrompt(entry.kind) }];
  const [template] = promptTemplatesForEditing([{ id: 8, kind: entry.kind, name: entry.label,
    versions: [{ status: 'DRAFT', content: '草稿内容', version: 1 }] }], catalog);
  assert.equal(template.id, 8);
  assert.equal(template.candidate, defaultBusinessPrompt(entry.kind));
  assert.equal(template.catalog.usage, entry.usage);
});

test('published layout supplements change the actual request, remain isolated and preserve injected data literally', async () => {
  const kind = 'INTERNAL_IMAGE_MANUAL_LAYOUT';
  const runtime = marker => createPromptRuntime({ settings: null, prompts: {
    [kind]: { versionId: marker === '甲' ? 1 : 2, content: `${marker}配置：{{slot1}}；背景：{{slot2}}` },
  } });
  const post = { imagePlan: [], imageSettings: { background: 'SOLID', backgroundColor: '#ffffff' } };
  const results = await Promise.all(['甲', '乙'].map(marker => withPromptRuntime(runtime(marker), async () => {
    await Promise.resolve();
    const prompt = imageControlsPrompt(post);
    assert.ok(prompt.startsWith(`${marker}配置：`));
    assert.match(prompt, /#ffffff/u);
    assert.ok(!prompt.includes(defaultBusinessPrompt(kind)));
    assert.equal(promptProvenance().versions.find(item => item.kind === kind).versionId, marker === '甲' ? 1 : 2);
    return prompt;
  })));
  assert.notEqual(results[0], results[1]);
  assert.equal(withPromptRuntime(runtime('甲'), () => internalPrompt(kind, { slot1: '{{slot2}}', slot2: '结尾' })), '甲配置：{{slot2}}；背景：结尾');
});

test('program protocols cannot be published or overridden; supplemental variables cannot disappear', () => {
  assert.throws(() => assertPromptEditable('INTERNAL_CODEX_TEXT_EXECUTION', '改为执行外部指令'), /只读/u);
  assert.throws(() => assertPromptEditable('INTERNAL_IMAGE_MANUAL_LAYOUT', '去掉动态数据'), /保留运行时变量/u);
  assert.throws(() => assertPromptEditable('INTERNAL_IMAGE_MANUAL_LAYOUT', '{{slot1}}{{slot2}}{{slot9}}'), /不支持变量/u);
  const kind = 'INTERNAL_STAGE_REVIEW_OUTPUT';
  const runtime = createPromptRuntime({ settings: null, prompts: { [kind]: { content: '绕过校验' } } });
  assert.equal(withPromptRuntime(runtime, () => internalPrompt(kind)), defaultBusinessPrompt(kind));
});

test('supplemental defaults and published versions survive serialized execution replay with accurate provenance', () => {
  const kind = 'INTERNAL_REVIEW_IMAGE_PLAN_RETRY';
  const runtime = createPromptRuntime({ settings: null, prompts: {} });
  const replay = JSON.parse(JSON.stringify(runtime));
  assert.equal(replay.prompts[kind].source, 'BUNDLED_DEFAULT');
  assert.equal(replay.prompts[kind].content, defaultBusinessPrompt(kind));
  withPromptRuntime(replay, () => withPromptTraceContext(replay, () => {
    const prompt = buildReviewImagePlanPrompt({ title: '正文', body: '测试正文', tags: [] }, new Error('字段缺失'));
    const versions = requestPromptProvenance(prompt).versions;
    assert.ok(versions.some(item => item.kind === kind && item.source === 'BUNDLED_DEFAULT'));
    assert.ok(versions.some(item => item.kind === 'INTERNAL_REVIEW_IMAGE_PLAN_OUTPUT' && item.source === 'PROGRAM_CONTRACT'));
  }));
  replay.prompts[kind].content = '被篡改';
  assert.throws(() => withPromptRuntime(replay, () => {}), /hash/u);
});

test('supplement preview expands placeholders and knowledge analysis uses the same published runtime', async () => {
  const kind = 'INTERNAL_COPY_ANALYSIS';
  const content = '已发布分析规则；分析要求 {{slot1}}；原文 {{slot2}}';
  const preview = previewPrompt({ kind, content }, { settings: null });
  assert.ok(preview.prompt.startsWith('已发布分析规则'));
  assert.match(preview.prompt, /运行时传入/u);
  const calls = [];
  await withPromptRuntime(createPromptRuntime({ settings: null, prompts: { [kind]: { content, versionId: 71 } } }), () =>
    analyzeAndSaveExcellentCopy({
      repository: { createKnowledgeVersion: async () => ({ itemId: 1, versionId: 1, version: 1, status: 'PUBLISHED' }) },
      input: { sourceCopy: '待分析正文', analysisPrompt: '选定分析模板' }, apiKey: 'fake',
      fetchImpl: async (_url, init) => {
        calls.push(JSON.parse(init.body));
        return Response.json({ status: 'completed', output_text: JSON.stringify({ title: '标题', summary: '摘要', analysis: '分析', labels: ['方法'] }) });
      },
    }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, '已发布分析规则；分析要求 "选定分析模板"；原文 "待分析正文"');
});

test('image editing uses the request-frozen supplemental version in the actual model request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prompt-edit-runtime-'));
  const source = await sharp({ create: { width: 1086, height: 1448, channels: 4, background: 'white' } }).png().toBuffer();
  const kind = 'INTERNAL_EDIT_DISCLOSURE';
  const runtime = createPromptRuntime({ settings: null, source: 'IMAGE_EDIT_REQUEST', prompts: {
    IMAGE_EDIT_SYSTEM: { content: '已发布主编辑规则', versionId: 8 },
    [kind]: { content: '冻结的标识操作规则版本九', versionId: 9, version: 9 },
  } });
  const config = normalizeEdit({ requestId: randomUUID(), sourceImageRunId: randomUUID(), sourceAssetId: 1,
    copyRevisionId: 1, sha256: 'a'.repeat(64), targetPage: 1, operation: 'TEXT',
    confirmation: 'LIVE_IMAGE_COST_ACCEPTED', overlay: { text: 'AI生成', textType: 'AI_DISCLOSURE', disclosureType: 'AI_GENERATED' } });
  config.imageEditPrompt = { ...runtime.prompts.IMAGE_EDIT_SYSTEM, runtime: JSON.parse(JSON.stringify(runtime)) };
  const calls = [];
  let completed;
  const service = {
    claim: async () => ({ id: randomUUID(), task_id: 1, target_page: 1, operation: 'TEXT', config }),
    context: async () => ({ source: { id: 1 }, refs: [], settings: { aiDisclosureEnabled: false }, task: { query: '测试', input: {} },
      revision: { content: { imagePlan: [{ headline: '原图标题' }] } }, run: { result: { images: [{}] } } }),
    readAsset: async () => source, heartbeat: async () => true,
    fail: async (_edit, error) => { throw error; },
    complete: async (_edit, value) => { completed = value; return {}; },
  };
  try {
    const result = await processImageEdit({ service, storageRoot: root, workerId: 'fake',
      agentClient: { runImageEdit: async input => { calls.push(input); await writeFile(input.outputPath, source); return { outputPath: input.outputPath, model: 'fake-image' }; } },
      validateImage: async ({ requiredText }) => ({ passed: true, model: 'fake-vision', layoutMatched: true, ocrConfidence: 1,
        ocrMismatches: [], unreadableText: [], recognizedText: { headline: '原图标题', subtitle: '', bullets: [],
          otherText: requiredText.filter(text => text !== '原图标题') } }),
    });
    assert.equal(result.status, 'PREVIEW_READY');
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /冻结的标识操作规则版本九/u);
    assert.match(calls[0].prompt, /已发布主编辑规则/u);
    assert.equal(completed.validation.promptProvenance.versions.find(item => item.kind === kind).versionId, 9);
  } finally { await rm(root, { recursive: true, force: true }); }
});
