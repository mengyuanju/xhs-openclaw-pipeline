import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { createAgentClient } from '../src/agent-client.mjs';
import { createControlPlaneClient } from '../src/control-plane/client.mjs';
import { withModelCallTracing, safeTraceText } from '../src/model-call-trace.mjs';

// Explicit opt-in: this separate runner consumes model quota, unlike npm test.
const args = process.argv.slice(2);
assert.ok(args.includes('--live') && args.every(arg => arg === '--live' || /^--case=LM-0[1-7]$/u.test(arg)), 'Run with --live only after the user authorizes real models');
const selectedCase = args.find(arg => arg.startsWith('--case='))?.slice(7);
const output = resolve('reports/full-functional-2026-10-02/live-model');
await mkdir(output, { recursive: true });
const environment = { ...process.env, XHS_CODEX_RUNTIME_DB: resolve(output, 'isolated-runtime.sqlite'),
  XHS_CODEX_CONCURRENCY: '1', XHS_CODEX_IMAGE_CONCURRENCY: '1' };
let modelApi = {};
if (environment.CONTROL_PLANE_URL) {
  const settings = await createControlPlaneClient({ baseUrl: environment.CONTROL_PLANE_URL }).listSettings();
  modelApi = settings.find(record => record.key === 'production')?.value?.modelApi ?? {};
}
const client = createAgentClient({ environment, modelApi });
const report = { startedAt: new Date().toISOString(), source: 'Actual application model adapter',
  businessDatabaseWrites: 0, cases: [], modelCalls: [] };
const tracePlane = { async recordModelCall(_executionId, id, record) {
  const index = report.modelCalls.findIndex(item => item.id === id);
  const entry = { id, ...record };
  if (index < 0) report.modelCalls.push(entry); else report.modelCalls[index] = entry;
  await save();
} };
async function save() { await writeFile(resolve(output, selectedCase ? `results-retest-${selectedCase}.json` : 'results.json'), JSON.stringify(report, null, 2)); }
async function run(id, name, action) {
  if (selectedCase && selectedCase !== id) return;
  const start = Date.now();
  console.log(`START ${id} ${name}`);
  try {
    const evidence = await withModelCallTracing({ executionId: id, controlPlane: tracePlane }, action);
    report.cases.push({ id, name, status: 'PASSED', durationMs: Date.now() - start, evidence });
    console.log(`PASS ${id}`);
  } catch (error) {
    report.cases.push({ id, name, status: 'FAILED', durationMs: Date.now() - start,
      error: safeTraceText(error.message).text, code: error.code ?? null });
    console.log(`FAIL ${id} ${error.code ?? ''} ${safeTraceText(error.message).text}`);
  }
  await save();
}
const generated = resolve(output, 'generated.png');
const edited = resolve(output, 'edited.png');
await run('LM-01', '真实模型登录及可用性预检', async () => client.checkReady());
await run('LM-02', '真实文案生成和结构化返回', async () => {
  const result = await client.runText({ prompt: '请为系统功能测试写一条桌面整理文案。返回JSON对象，title为10到20个汉字标题，body为80到120个汉字的步骤说明。不要声称亲身经历，不要调用工具。',
    outputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'], additionalProperties: false }, timeoutMs: 180_000 });
  const content = JSON.parse(result.rawText);
  assert.ok(content.title && content.body);
  return { provider: result.provider, model: result.model, content, execution: result.execution };
});
await run('LM-03', '真实文案审核', async () => {
  const result = await client.runReview({ prompt: '请审核以下测试文案是否有虚构第一人称体验：先清空桌面，再按使用频率把物品分区，常用文具放手边。只返回中文审核结论和一句理由。', timeoutMs: 180_000 });
  assert.ok(result.rawText.length > 0);
  return result;
});
await run('LM-04', '真实联网检索及来源返回', async () => {
  const result = await client.runWebSearch({ query: '查找Node.js官方网站的node:test文档，给出官方文档地址与简短说明', limit: 2, timeoutMs: 120_000 });
  const sources = result.result?.results ?? result.result?.sources;
  assert.ok(sources?.length > 0);
  assert.ok(sources.every(item => /^https?:\/\//u.test(item.url)));
  return result;
});
await run('LM-05', '真实图片生成及PNG接收', async () => {
  const result = await client.runImage({ prompt: '生成一张简洁桌面收纳主题的竖版插画，一张木桌上放蓝色杯子、三本书和绿色植物。浅米色背景，无文字，无人物。这是系统功能测试图。请使用原生图片生成工具生成。', outputPath: generated, timeoutMs: 540_000 });
  const metadata = await sharp(generated).metadata();
  assert.equal(metadata.format, 'png');
  const bytes = await readFile(generated);
  return { ...result, image: { width: metadata.width, height: metadata.height, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') } };
});
const sourceImagePassed = report.cases.find(item => item.id === 'LM-05')?.status === 'PASSED'
  || (selectedCase && ['LM-06', 'LM-07'].includes(selectedCase)
    && JSON.parse(await readFile(resolve(output, 'results.json'), 'utf8')).cases.find(item => item.id === 'LM-05')?.status === 'PASSED');
if (sourceImagePassed) {
  await run('LM-06', '真实图片视觉识别', async () => {
    const result = await client.runVision({ prompt: '描述图片里桌面上的物件及杯子的颜色，给出中文观察结果。', inputPaths: [generated], timeoutMs: 180_000 });
    assert.ok(result.rawText.length > 0); return result;
  });
  await run('LM-07', '真实图片编辑及产物接收', async () => {
    const result = await client.runImageEdit({ prompt: '把图中蓝色杯子改为红色，保持桌子、三本书、绿色植物、背景和构图一致，不添加文字或人物。请使用原生图片编辑生成工具。',
      inputPaths: [generated], outputPath: edited, timeoutMs: 540_000 });
    const bytes = await readFile(edited), metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, 'png');
    assert.notEqual(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(await readFile(generated)).digest('hex'));
    return { ...result, image: { width: metadata.width, height: metadata.height, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') } };
  });
} else {
  for (const id of ['LM-06', 'LM-07']) if (!selectedCase || selectedCase === id) report.cases.push({ id, status: 'BLOCKED', reason: '真实生成图片未成功，缺少待识别和编辑的源图' });
}
report.completedAt = new Date().toISOString();
report.passed = report.cases.every(item => item.status === 'PASSED');
await save();
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.map(({ id, status }) => ({ id, status })), modelCalls: report.modelCalls.length }));
process.exitCode = report.passed ? 0 : 1;
