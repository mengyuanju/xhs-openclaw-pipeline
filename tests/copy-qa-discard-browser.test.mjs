import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('copy QA discard browser: required reason, cancel, failed retry identity and immutable discarded history', {
  skip: process.env.RUN_COPY_QA_DISCARD_BROWSER !== '1', timeout: 90_000,
}, async () => {
  const { build } = await import('esbuild'); const { chromium } = await import('playwright-core');
  const directory = await mkdtemp(join(tmpdir(), 'copy-qa-discard-browser-'));
  const output = resolve('reports/full-functional-2026-10-02'); await mkdir(output, { recursive: true });
  await build({ stdin: { contents: "import './app/globals.css';import React from'react';import{createRoot}from'react-dom/client';import{ConfirmDialogProvider}from'./components/ui/confirm-dialog';import{CopyQaWorkbench}from'./app/copy-qa/copy-qa-workbench';createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><CopyQaWorkbench/></ConfirmDialogProvider>);", resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(directory, 'bundle.js'), jsx: 'automatic', platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' } });
  const js = await readFile(join(directory, 'bundle.js')); const rawCss = await readFile(join(directory, 'bundle.css'), 'utf8');
  const { default: postcss } = await import('postcss'); const { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });
  const batch = { id: 'fixture-batch', displayName: '合成废弃与历史批次', mode: 'PERSONAL_AUTO', status: 'INSPECTING', memberCount: 2, sampleCount: 2, pendingCount: 2, passedCount: 0, returnedCount: 0, discardedCount: 0, affectedCount: 0, fullInspection: false, returnTriggerCount: 1, createdAt: '2026-10-02T08:00:00Z' };
  const item = { id: 'fixture-item', taskId: null, query: null, content: { copy: { title: '最终稿合成标题', body: '最终稿正文应保持可读', tags: ['合成'] }, imagePlan: [{ headline: '最终配图规划', bullets: ['合成要点'] }] }, status: 'PENDING', approverUsername: null, revisionToken: 'a'.repeat(64), discardReasonCode: null, dispositionNote: null };
  const decisions = [], errors = [], originalContent = structuredClone(item.content); let failNext = true, denied = false, browser;
  const server = createServer(async (request, response) => {
    const p = new URL(request.url, 'http://localhost').pathname;
    if (p === '/bundle.js') { response.setHeader('content-type', 'application/javascript'); response.end(js); return; }
    if (p === '/bundle.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
    if (!p.startsWith('/api/')) { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><main id="root"></main><script src="/bundle.js"></script></html>'); return; }
    const reply = (data, status = 200) => { response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(status >= 400 ? { error: { code: 'FIXTURE', message: data } } : { data })); };
    if (denied) { reply('当前账号没有文案质检权限', 403); return; }
    if (request.method === 'GET' && p.endsWith('/batches')) { reply({ items: [batch], total: 1, limit: 20, offset: 0 }); return; }
    if (request.method === 'GET' && p.endsWith('/batches/fixture-batch')) { reply({ batch, items: [item], pagination: { total: 1, limit: 50, offset: 0 } }); return; }
    if (request.method === 'POST' && p.endsWith('/items/fixture-item/decision')) {
      let raw = ''; for await (const chunk of request) raw += chunk; const payload = JSON.parse(raw); decisions.push(payload);
      if (failNext) { failNext = false; reply('合成临时失败，请重试原废弃操作', 503); return; }
      assert.equal(payload.decision, 'DISCARD'); item.status = 'DISCARDED'; item.discardReasonCode = payload.discardReasonCode; item.dispositionNote = payload.note;
      batch.discardedCount = 1; batch.pendingCount = 1; reply({ item, batch }); return;
    }
    reply('Unexpected fixture request', 404);
  });
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done)); const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.getByRole('button', { name: '进入批次', exact: true }).click();
    await page.getByText('质检项驳回达到 1 条后，系统自动处理剩余成员。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '查看并质检', exact: true }).click();
    assert.equal(await page.getByText('独立盲评', { exact: true }).isVisible(), true); await page.getByRole('button', { name: '废弃任务', exact: true }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '废弃文案任务', exact: true }) });
    await dialog.getByRole('button', { name: '继续废弃', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: '请选择废弃理由并填写说明' }).waitFor(); assert.equal(decisions.length, 0);
    await dialog.getByLabel('废弃理由', { exact: true }).selectOption({ index: 1 }); await dialog.getByLabel('废弃说明（必填）', { exact: true }).fill('合成废弃说明：当前题目不适合生产');
    await dialog.getByRole('button', { name: '继续废弃', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click(); assert.equal(decisions.length, 0); assert.equal(item.status, 'PENDING');
    await dialog.getByRole('button', { name: '继续废弃', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '确认废弃', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: '合成临时失败' }).waitFor(); assert.equal(await dialog.getByLabel('废弃说明（必填）', { exact: true }).inputValue(), '合成废弃说明：当前题目不适合生产'); assert.equal(item.status, 'PENDING');
    await dialog.getByRole('button', { name: '继续废弃', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '确认废弃', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(decisions.length, 2); assert.equal(decisions[0].requestId, decisions[1].requestId); assert.equal(decisions[1].revisionToken, item.revisionToken); assert.equal(batch.returnedCount, 0); assert.equal(batch.affectedCount, 0); assert.deepEqual(item.content, originalContent);
    await page.getByRole('button', { name: '查看文案', exact: true }).click(); const history = page.getByRole('dialog');
    await history.getByText('最终稿合成标题', { exact: true }).waitFor(); await history.getByText(/废弃理由：.*合成废弃说明/).waitFor();
    assert.equal(await history.getByRole('button', { name: /通过质检|仅打回此条|废弃任务/ }).count(), 0); await history.getByRole('button', { name: '关闭', exact: true }).click();
    denied = true; await page.goto(origin); await page.getByRole('alert').filter({ hasText: '当前账号没有文案质检权限' }).waitFor(); assert.equal(await page.getByRole('button', { name: '进入批次', exact: true }).count(), 0);
    assert.deepEqual(errors, []); await writeFile(join(output, 'copy-qa-discard-browser-evidence.json'), JSON.stringify({ status: 'PASS', evidenceType: 'UI_FIXTURE', modelCalls: 0, featureIds: ['F-CQA-012', 'F-CQA-013', 'F-CQA-014', 'F-CQA-015'], scope: '实际废弃理由必填、二次确认取消与确认、失败保持与相同requestId重试、已废弃只读最终稿/理由和403门禁反馈；阈值实际服务器处置与自检/陈旧版本由独立PG/HTTP测试负责。' }, null, 2));
  } finally { await browser?.close(); await new Promise(done => server.close(done)); assert.ok(resolve(directory).startsWith(resolve(tmpdir()))); await rm(directory, { recursive: true, force: true }); }
});
