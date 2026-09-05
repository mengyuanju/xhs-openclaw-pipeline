import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockPost } from '../src/pipeline.mjs';
import { createMockVisualPlan, parseVisualPlanOutput } from '../src/visual-plan.mjs';
import { generateVisualPlan } from '../src/visual-plan-generation.mjs';

const post = createMockPost(3);
const valid = () => createMockVisualPlan(post);

test('planning passes configured thinking and the business schema, not a rawText wrapper', async () => {
  let calls = 0;
  const result = await generateVisualPlan({ post, thinking: 'medium', client: { async runText(input) {
    calls += 1;
    assert.equal(input.thinking, 'medium');
    assert.ok(input.outputSchema.properties.pages);
    assert.equal(input.outputSchema.properties.rawText, undefined);
    assert.match(input.prompt, /画面元素/u);
    return { rawText: JSON.stringify(valid()), model: 'fake' };
  } } });
  assert.equal(calls, 1);
  assert.equal(result.degraded, false);
});

test('repairs only invalid pages using retained output and never replaces valid pages', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'xhs-plan-repair-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const original = valid();
  original.pages[0].mustShow = ['不存在的文字'];
  let calls = 0;
  const result = await generateVisualPlan({ post, thinking: 'low', outputDir, client: { async runText(input) {
    if (++calls === 1) return { rawText: JSON.stringify(original), model: 'fake' };
    assert.equal(input.thinking, 'low');
    assert.match(input.prompt, /不存在的文字/);
    assert.match(input.prompt, /"repairPageIndices":\[1\]/);
    return { rawText: JSON.stringify({ pages: [valid().pages[0]] }), model: 'fake' };
  } } });
  assert.equal(calls, 2);
  assert.deepEqual(result.visualPlan.pages[1], parseVisualPlanOutput(JSON.stringify(valid()), { post }).pages[1]);
  const attempt = JSON.parse(await readFile(join(outputDir, 'visual-plan-attempt-1.json'), 'utf8'));
  assert.match(attempt.rawText, /不存在的文字/);
  assert.equal(attempt.errors[0].pageIndex, 1);
});

test('repair responses cannot overwrite already validated pages or root metadata', async () => {
  const first = valid();
  first.pages[0].sourceEvidence = ['不是正文'];
  let calls = 0;
  const result = await generateVisualPlan({ post, client: { async runText() {
    const candidate = ++calls === 1 ? first : valid();
    if (calls > 1) { candidate.contentProfile.category = '偷偷修改'; candidate.pages[1].visualSubject = '偷偷修改'; }
    return { rawText: JSON.stringify(candidate) };
  } } });
  assert.equal(calls, 2);
  assert.equal(result.visualPlan.pages[1].visualSubject, first.pages[1].visualSubject);
  assert.equal(result.visualPlan.contentProfile.category, first.contentProfile.category);
});

test('exhausted repairs preserve valid pages and explicitly mark deterministic degradation', async () => {
  const candidate = valid(); candidate.pages[0].sourceEvidence = ['不是正文'];
  candidate.pages[1].visualSubject = '保留已通过的构图';
  let calls = 0;
  const result = await generateVisualPlan({ post, client: { async runText() {
    calls += 1; return { rawText: JSON.stringify(candidate) };
  } } });
  assert.equal(calls, 3);
  assert.equal(result.degraded, true);
  assert.equal(result.visualPlan.pages[1].visualSubject, candidate.pages[1].visualSubject);
  assert.equal(result.warning.code, 'VISUAL_PLAN_SCHEMA_FALLBACK');
});

test('authentication errors propagate immediately without fallback or extra calls', async () => {
  let calls = 0;
  await assert.rejects(generateVisualPlan({ post, client: { async runText() {
    calls += 1; throw Object.assign(new Error('login required'), { code: 'CODEX_AUTH_REQUIRED' });
  } } }), { code: 'CODEX_AUTH_REQUIRED' });
  assert.equal(calls, 1);
});

test('explicit graphical requirements avoid literal-text ambiguity but visible literals stay checked', () => {
  const candidate = valid();
  candidate.pages[0].mustShow = ['画面：用于提醒的抽象图标提示'];
  assert.doesNotThrow(() => parseVisualPlanOutput(JSON.stringify(candidate), { post }));
  candidate.pages[0].mustShow = ['文字：凭空增加的标签'];
  assert.throws(() => parseVisualPlanOutput(JSON.stringify(candidate), { post }), /absent from allowedVisibleText/);
});

test('malformed repair responses never discard the previously valid subset', async () => {
  const candidate = valid(); candidate.pages[0].sourceEvidence = [];
  candidate.pages[1].visualSubject = '保留已通过的构图';
  let calls = 0;
  const result = await generateVisualPlan({ post, client: { async runText() {
    return { rawText: ++calls === 1 ? JSON.stringify(candidate) : 'not JSON' };
  } } });
  assert.equal(calls, 3);
  assert.equal(result.visualPlan.pages[1].visualSubject, '保留已通过的构图');
});

test('retained invalid output is bounded and credentials are redacted', async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), 'xhs-plan-redact-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  await generateVisualPlan({ post, outputDir, client: { async runText() {
    return { rawText: 'Bearer abcdefghijklmnop ' + 'x'.repeat(60000) };
  } } });
  const saved = await readFile(join(outputDir, 'visual-plan-attempt-1.json'), 'utf8');
  assert.equal(saved.includes('abcdefghijklmnop'), false);
  assert.ok(saved.length < 52000);
});

test('a missing page does not discard completed pages or ask the model to rewrite them', async () => {
  const first = valid();
  first.pages[0].visualSubject = '保留已完成封面构图';
  first.pages[1].visualSubject = '保留已完成内页构图';
  first.pages.pop();
  let calls = 0;
  const result = await generateVisualPlan({ post, client: { async runText(input) {
    calls += 1;
    if (calls === 1) return { rawText: JSON.stringify(first), model: 'fake' };
    assert.match(input.prompt, /"repairPageIndices":\[3\]/u);
    return { rawText: JSON.stringify({ ...valid(), pages: [valid().pages[2]] }), model: 'fake' };
  } } });
  assert.equal(calls, 2);
  assert.equal(result.degraded, false);
  assert.equal(result.visualPlan.pages[0].visualSubject, first.pages[0].visualSubject);
  assert.equal(result.visualPlan.pages[1].visualSubject, first.pages[1].visualSubject);
  assert.equal(result.visualPlan.pages.length, 3);
});
