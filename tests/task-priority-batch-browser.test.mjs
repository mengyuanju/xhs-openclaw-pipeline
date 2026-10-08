import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('task priority browser: all modes, same production batch scope, preview versions, cancellation and stale recovery', {
  skip: process.env.RUN_TASK_PRIORITY_BATCH_BROWSER !== '1', timeout: 120000,
}, async () => {
  const { build } = await import('esbuild'), { chromium } = await import('playwright-core');
  const directory = await mkdtemp(join(tmpdir(), 'priority-batch-browser-')), out = resolve('reports/full-functional-2026-10-02'); await mkdir(out, { recursive: true });
  await build({ stdin: { contents: `import'./app/globals.css';import React from'react';import{createRoot}from'react-dom/client';import{TaskPriorityControl}from'./app/workbench/task-priority-control';const mixed=location.search.includes('mixed');createRoot(document.getElementById('root')).render(<TaskPriorityControl tasks={[{id:11,productionBatchId:33,priorityVersion:1},{id:12,productionBatchId:mixed?34:33,priorityVersion:2}]}onChanged={()=>{window.__priorityChanged=(window.__priorityChanged??0)+1}}/>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(directory, 'bundle.js'), jsx: 'automatic', platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' } });
  const { default: postcss } = await import('postcss'), { default: tailwind } = await import('@tailwindcss/postcss'); const { css } = await postcss([tailwind()]).process(await readFile(join(directory, 'bundle.css'), 'utf8'), { from: resolve('app/globals.css') }); await writeFile(join(directory, 'bundle.css'), css);
  const scopes = [], writes = [], errors = [], unexpected = []; let scopeFail = false, saveFail = false, priorityVersion = 1;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture'); if (url.pathname === '/bundle.js' || url.pathname === '/bundle.css') { response.setHeader('content-type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(await readFile(join(directory, url.pathname.slice(1)))); return; }
    const reply = (data, status = 200) => { response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(status >= 400 ? { error: { code: 'PRIORITY_FIXTURE', message: data } } : { data })); };
    if (url.pathname.startsWith('/api/')) {
      let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw);
      if (url.pathname.endsWith('/priority-scope')) { scopes.push(body); if (scopeFail) { scopeFail = false; reply('范围读取暂时失败，保留原因后重试', 503); return; } const ids = body.productionBatchId ? [11, 12, 13] : body.taskIds; reply({ scope: body, items: ids.map((id, index) => ({ id, priorityVersion: priorityVersion + index, productionBatchId: 33 })) }); return; }
      if (url.pathname.endsWith('/priority')) { writes.push(body); if (saveFail) { saveFail = false; priorityVersion++; reply('priorityVersion已变化，请重新预览', 409); return; } for (const [id, version] of Object.entries(body.expectedVersions)) assert.equal(version, priorityVersion + Number(id) - 11); reply({ changed: Object.keys(body.expectedVersions).length }); return; }
      unexpected.push(url.pathname); reply('Unexpected fixture route', 404); return;
    }
    response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><body style="padding:24px"><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ channel: 'msedge', headless: true }); const page = await browser.newPage({ viewport: { width: 1280, height: 960 } }); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  const dialog = page.getByRole('dialog'), reason = dialog.getByPlaceholder('请说明本次调整的原因，便于后续追溯', { exact: true }), preview = dialog.getByRole('button', { name: '预览调整范围', exact: true }), confirm = dialog.getByRole('button', { name: '确认调整并记录原因', exact: true });
  async function open() { await page.getByRole('button', { name: '调整优先级', exact: true }).click(); await dialog.waitFor(); }
  try {
    await page.goto(origin); await open(); assert.ok(await preview.isDisabled()); await reason.fill(' '); assert.ok(await preview.isDisabled()); assert.equal(await reason.getAttribute('maxlength'), '2000'); await reason.fill('合成整批优先级调整');
    await dialog.getByRole('checkbox', { name: /调整整个生产批次 #33/ }).check(); scopeFail = true; await preview.click(); await dialog.getByRole('alert').filter({ hasText: '范围读取暂时失败' }).waitFor(); assert.equal(await reason.inputValue(), '合成整批优先级调整'); await preview.click(); await dialog.getByText('将调整 3 条任务', { exact: true }).waitFor(); assert.deepEqual(scopes.at(-1), { productionBatchId: 33 }); assert.match(await dialog.innerText(), /#11、#12、#13/); await dialog.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(writes.length, 0);
    await open(); await reason.fill('单次确认不会沿用上次整批勾选'); await preview.click(); await dialog.getByText('将调整 2 条任务', { exact: true }).waitFor(); assert.deepEqual(scopes.at(-1), { taskIds: [11, 12] }); await dialog.getByRole('checkbox', { name: /调整整个生产批次 #33/ }).check(); assert.equal(await confirm.count(), 0); await preview.click(); await confirm.click(); await dialog.waitFor({ state: 'hidden' }); assert.deepEqual(writes.at(-1).expectedVersions, { 11: 1, 12: 2, 13: 3 }); assert.equal(writes.at(-1).productionBatchId, 33); assert.equal(await page.evaluate(() => window.__priorityChanged), 1);
    const modes = [['HIGHEST', '最高优先 · 500'], ['HIGH', '高优先 · 350'], ['NORMAL', '普通 · 100'], ['DEFER', '暂缓 · 10'], ['PAUSE', '暂停'], ['SYSTEM', '跟随系统（恢复系统优先级）']];
    for (const [mode, label] of modes) { await open(); await dialog.getByRole('combobox', { name: '优先级', exact: true }).click(); await page.getByRole('option', { name: label, exact: true }).click(); await reason.fill(`合成${mode}调整`); await preview.click(); await confirm.click(); await dialog.waitFor({ state: 'hidden' }); assert.equal(writes.at(-1).mode, mode); assert.deepEqual(writes.at(-1).taskIds, [11, 12]); }
    await open(); await reason.fill('陈旧确认必须重新读取范围'); await dialog.getByRole('checkbox', { name: /调整整个生产批次 #33/ }).check(); await preview.click(); saveFail = true; await confirm.click(); await dialog.getByRole('alert').filter({ hasText: 'priorityVersion已变化' }).waitFor(); assert.equal(await confirm.count(), 0); assert.equal(await reason.inputValue(), '陈旧确认必须重新读取范围'); await preview.click(); await confirm.click(); await dialog.waitFor({ state: 'hidden' }); assert.deepEqual(writes.at(-1).expectedVersions, { 11: 2, 12: 3, 13: 4 });
    await page.goto(`${origin}?mixed=1`); await open(); assert.equal(await dialog.getByRole('checkbox').count(), 0); await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); await writeFile(join(out, 'task-priority-batch-browser-evidence.json'), JSON.stringify({ evidenceType: 'UI_HTTP_FIXTURE', modelCalls: 0, featureIds: ['F-ASSIGN-006', 'F-ASSIGN-007', 'F-ASSIGN-008', 'F-ASSIGN-009', 'F-ASSIGN-010'], scope: 'all6modes,reasonrequired2000,same-production-batch-only,scope503/retry,cancel0write,wholebatch3exactexpectedversions,409requiresnewpreviewandnewversions,mixedbatchhidesoption', scopes, writes, errors }, null, 2));
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});
