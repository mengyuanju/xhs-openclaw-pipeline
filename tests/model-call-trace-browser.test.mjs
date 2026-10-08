import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('saved Doubao research stays separate from actual calls and normalized search results', {
  skip: process.env.RUN_MODEL_CALL_TRACE_BROWSER !== '1', timeout: 120_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const directory = await mkdtemp(join(tmpdir(), 'model-call-trace-browser-'));
  const executionId = '609a03ab-d68b-42ab-b24d-2a3d10cf8eaa';
  const snapshot = {
    provider: 'doubao', query: '剪映怎么学习', searchedAt: '2026-09-30T06:00:00.000Z',
    summary: '先学会导入素材、剪切片段与导出。\n<script>window.__snapshotExecuted=true</script>\n<img src="https://unexpected.test/pixel">\napi_key=sk-fixture-private-key-value',
    attempts: [{ provider: 'doubao', status: 'COMPLETED' }],
    sources: Array.from({ length: 10 }, (_, index) => ({ title: `隔离来源 ${index + 1}`, url: `https://example.test/${index + 1}` })),
  };
  const call = (index, provider = 'Codex', operation = 'TEXT') => ({
    id: `call-${index}`, executionId, sequence: index, stage: operation === 'TEXT' ? 'TEXT_GENERATION' : 'RESEARCH',
    kind: 'COPY', nodeId: 'isolated-fixture', provider, operation, model: operation === 'TEXT' ? 'fixture-model' : '',
    status: 'SUCCEEDED', truncated: false, startedAt: '2026-09-30T06:01:00.000Z',
    executionStartedAt: '2026-09-30T06:00:00.000Z', durationMs: 2_000,
  });
  let browser;
  let server;
  const requests = [], unexpected = [], errors = [];
  let detailUnavailable = true;
  try {
    await build({
      stdin: { contents: `import './app/globals.css';import React,{useState}from'react';import{createRoot}from'react-dom/client';
        import{ModelCallTrace}from'./app/workbench/model-call-trace';
        const snapshot=${JSON.stringify(snapshot)};
        function Fixture(){const[changed,setChanged]=useState(false);return <>
          <button onClick={()=>setChanged(true)}>切换文案版本</button>
          <ModelCallTrace taskId={1061} researchSnapshot={changed?{...snapshot,provider:'deepseek',query:'新版本研究词',sources:[]}:snapshot}
            copyRevisionId={changed?4104:4103} researchExecutionId={changed?'new-revision-execution':'${executionId}'}/>
        </>};createRoot(document.getElementById('root')).render(<Fixture/>);`, resolveDir: process.cwd(), loader: 'tsx' },
      bundle: true, outfile: join(directory, 'bundle.js'), jsx: 'automatic', platform: 'browser', conditions: ['style'],
      alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [{ name: 'next-dynamic-fixture', setup(plugin) {
        plugin.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: 'next/dynamic', namespace: 'next-fixture' }));
        plugin.onLoad({ filter: /.*/, namespace: 'next-fixture' }, () => ({ loader: 'jsx', resolveDir: process.cwd(),
          contents: `import React,{lazy,Suspense}from'react';export default function dynamic(loader){
            const Component=lazy(()=>loader().then(defaultExport=>({default:defaultExport})));
            return props=><Suspense fallback={<span>阅读视图加载中</span>}><Component {...props}/></Suspense>}` }));
      } }],
    });
    const [javascript, rawCss] = await Promise.all([readFile(join(directory, 'bundle.js')), readFile(join(directory, 'bundle.css'), 'utf8')]);
    const { default: postcss } = await import('postcss');
    const { default: tailwind } = await import('@tailwindcss/postcss');
    const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });
    server = createServer((request, response) => {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/bundle.js') { response.setHeader('content-type', 'application/javascript'); response.end(javascript); return; }
      if (url.pathname === '/bundle.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
      if (!url.pathname.startsWith('/api/')) {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body style="padding:24px"><main id="root"></main><script src="/bundle.js"></script></body></html>'); return;
      }
      requests.push({ method: request.method, path: url.pathname, search: url.search });
      response.setHeader('content-type', 'application/json');
      const scenario = new URL(request.headers.referer ?? 'http://localhost').searchParams.get('scenario');
      let data;
      if (request.method === 'GET' && url.pathname === '/api/control-plane/v1/tasks/1061/model-calls') {
        const offset = Number(url.searchParams.get('offset'));
        const all = scenario === 'pages' ? Array.from({ length: 22 }, (_, index) => call(index + 1))
          : scenario === 'search' ? [call(1, 'Doubao', 'WEB_SEARCH'), call(2), call(3)] : scenario === 'failed' ? [{ ...call(1), status: 'FAILED', truncated: true }] : [call(1), call(2)];
        data = { items: all.slice(offset, offset + 20), total: all.length };
      } else if (request.method === 'GET' && url.pathname === '/api/control-plane/v1/tasks/1061/model-calls/call-1') {
        if (scenario === 'failed') {
          if (detailUnavailable) { detailUnavailable = false; response.statusCode = 503; response.end(JSON.stringify({ error: { code: 'FIXTURE', message: 'temporary trace detail unavailable' } })); return; }
          data = { ...call(1), status: 'FAILED', truncated: true, prompt: '合成失败请求的原始提示词 <script>window.__traceExecuted=1</script>', error: '合成调用失败：服务暂不可用', response: null,
            request: JSON.stringify({ format: 'xhs-model-request', schemaVersion: 1, scope: 'CLI_INPUT', payload: { args: ['exec', '--image', '/synthetic/reference.png', '--sandbox', 'read-only'], input: '合成请求' } }) };
        } else {
        data = { ...call(1, 'Doubao', 'WEB_SEARCH'), prompt: '', request: '{}',
          response: JSON.stringify({ httpStatus: 200, scope: 'NORMALIZED_SEARCH_EVIDENCE', result: { content: '归一化的豆包结果', sources: snapshot.sources } }) };
        }
      } else { unexpected.push(`${request.method} ${url.pathname}`); response.statusCode = 404; }
      response.end(JSON.stringify({ data }));
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    browser = await chromium.launch({ headless: true, channel: process.env.MODEL_CALL_TRACE_BROWSER_CHANNEL ?? 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
      unexpected.push(route.request().url()); return route.abort();
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin);
    assert.equal(requests.length, 0, 'collapsed history must remain lazy');
    await page.getByRole('button', { name: /模型调用链路/u }).click();
    await page.getByText('共 2 次调用', { exact: true }).waitFor();
    // The snapshot is a named section, not a numbered call or HTTP reconstruction.
    const snapshotSection = page.locator('section[aria-label="当前文案保存的搜索记录"]');
    assert.equal(await snapshotSection.count(), 1);
    assert.match(await snapshotSection.innerText(), /豆包 · 10 条来源/u);
    assert.match(await snapshotSection.innerText(), /文案版本 4103/u);
    assert.match(await snapshotSection.innerText(), new RegExp(executionId, 'u'));
    assert.match(await snapshotSection.innerText(), /研究词（非完整 HTTP 请求）：剪映怎么学习/u);
    assert.match(await snapshotSection.innerText(), /1\. 豆包（已返回来源）/u);
    assert.match(await snapshotSection.innerText(), /不计入模型调用次数/u);
    assert.equal(await page.locator('.model-call-card').count(), 2);
    await page.getByRole('button', { name: '研究摘要（已脱敏）', exact: true }).click();
    assert.match(await snapshotSection.innerText(), /先学会导入素材/u);
    assert.doesNotMatch(await snapshotSection.innerText(), /sk-fixture-private-key-value/u);
    assert.match(await snapshotSection.innerText(), /\[REDACTED\]/u);
    assert.equal(await snapshotSection.locator('script,img').count(), 0);
    assert.equal(await page.evaluate(() => window.__snapshotExecuted), undefined);
    if (process.env.MODEL_CALL_TRACE_SCREENSHOT) {
      await mkdir(resolve(process.env.MODEL_CALL_TRACE_SCREENSHOT, '..'), { recursive: true });
      await page.screenshot({ path: process.env.MODEL_CALL_TRACE_SCREENSHOT, fullPage: true });
    }
    await page.getByRole('button', { name: '切换文案版本', exact: true }).click();
    assert.match(await snapshotSection.innerText(), /文案版本 4104/u);
    assert.match(await snapshotSection.innerText(), /DeepSeek · 0 条来源/u);
    assert.match(await snapshotSection.innerText(), /new-revision-execution/u);
    assert.equal(await page.locator('.model-call-card').count(), 2);

    await page.goto(`${origin}/?scenario=pages`);
    await page.getByRole('button', { name: /模型调用链路/u }).click();
    await page.getByText('共 22 次调用', { exact: true }).waitFor();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.getByText('第 2 页 / 共 2 页', { exact: true }).waitFor();
    await page.getByText('共 22 次调用', { exact: true }).waitFor();
    assert.equal(await snapshotSection.count(), 1);
    assert.match(await snapshotSection.innerText(), /豆包 · 10 条来源/u);
    assert.equal(await page.locator('.model-call-card').count(), 2);

    await page.goto(`${origin}/?scenario=search`);
    await page.getByRole('button', { name: /模型调用链路/u }).click();
    await page.getByText('共 3 次调用', { exact: true }).waitFor();
    const searchCall = page.locator('.model-call-card').first();
    assert.match(await searchCall.innerText(), /Doubao · 搜索服务 · 联网搜索/u);
    assert.doesNotMatch(await searchCall.innerText(), /未暴露模型名称/u);
    await searchCall.getByRole('button', { name: /第 1 步/u }).click();
    await searchCall.getByRole('heading', { name: '搜索结果（已脱敏）', exact: true }).waitFor();
    await searchCall.getByText('归一化的豆包结果', { exact: true }).waitFor();
    assert.equal(await snapshotSection.count(), 1);
    await page.goto(`${origin}/?scenario=failed`);
    await page.getByRole('button', { name: /模型调用链路/u }).click(); await page.getByText('共 1 次调用', { exact: true }).waitFor();
    const failedCall = page.locator('.model-call-card').first(); await failedCall.getByRole('button', { name: /第 1 步/u }).click();
    await failedCall.getByRole('alert').filter({ hasText: 'temporary trace detail unavailable' }).waitFor(); await failedCall.getByRole('button', { name: '重试加载', exact: true }).click();
    await failedCall.getByText('合成调用失败：服务暂不可用', { exact: true }).waitFor(); await failedCall.getByText('记录内容过长，已截断展示；并非完整原文。', { exact: true }).waitFor();
    await failedCall.getByRole('button', { name: '本次调用附件（文件位置，未保存图片二进制）', exact: true }).click(); await failedCall.locator('pre').filter({ hasText: /\/synthetic\/reference\.png/ }).first().waitFor();
    const promptToggle = failedCall.getByRole('button', { name: '提示词记录（可能已截断）', exact: true }); await promptToggle.click();
    const promptContent = page.locator(`[id="${await promptToggle.getAttribute('aria-controls')}"] pre`); await promptContent.waitFor(); assert.equal(await promptContent.innerText(), '合成失败请求的原始提示词 <script>window.__traceExecuted=1</script>'); assert.equal(await page.evaluate(() => window.__traceExecuted), undefined);
    await failedCall.getByRole('button', { name: '脱敏请求记录（完整性未确认）', exact: true }).click(); await failedCall.getByText('该记录缺失、已截断或属于旧格式，不能当作完整请求。', { exact: true }).waitFor();
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    assert.ok(requests.every(request => request.method === 'GET'));
  } finally {
    await browser?.close();
    if (server) await new Promise(done => server.close(done));
    const resolvedDirectory = resolve(directory), resolvedTemp = resolve(tmpdir());
    assert.ok(resolvedDirectory.startsWith(`${resolvedTemp}\\`) || resolvedDirectory.startsWith(`${resolvedTemp}/`));
    await rm(resolvedDirectory, { recursive: true, force: true });
  }
});
