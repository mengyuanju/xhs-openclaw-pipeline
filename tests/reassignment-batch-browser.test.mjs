import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const apiRoot = '/api/control-plane/v1/admin/reassignment-cases';

function createCases(count = 31) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 11, taskId: index + 101, stage: index % 2 ? 'IMAGE' : 'COPY',
    query: ['桌面收纳的分区方法', '小空间衣柜的整理顺序', '换季收纳工具清单', '春日玄关整理'][index % 4],
    status: 'PENDING', version: index + 3, resetStatus: 'READY', cleanupStatus: 'COMPLETE',
    resetError: null, baselineSource: 'GENERATION', canAssign: true,
    operatorAccountId: 7, operatorName: '原标注员', note: '复检未通过，移交管理员重新分配。',
    createdAt: '2026-09-29T08:30:00.000Z',
    ...(index === 2 ? { resetStatus: 'BLOCKED', cleanupStatus: 'FAILED', canAssign: false,
      resetError: '未找到可信机器初稿，需要重试还原', baselineSource: null } : {}),
    ...(index === 3 ? { resetStatus: 'REGENERATING', cleanupStatus: 'PENDING', canAssign: false } : {}),
  }));
}

test('reassignment batch browser: selection, gates, partial results, retry IDs and responsive dialogs', {
  skip: process.env.RUN_REASSIGNMENT_BATCH_BROWSER !== '1', timeout: 120_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const output = resolve('.codex_artifacts/reassignment-batch');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'browser-'));
  const bundle = join(directory, 'bundle.js');
  await build({
    stdin: { contents: `
      import './app/globals.css';
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {ReassignmentQueue} from './app/reassignment/reassignment-queue';
      createRoot(document.getElementById('root')).render(<ReassignmentQueue/>);
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, outfile: bundle, jsx: 'automatic', platform: 'browser', conditions: ['style'],
    alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' },
  });
  const [js, rawCss] = await Promise.all([readFile(bundle), readFile(join(directory, 'bundle.css'), 'utf8')]);
  const { default: postcss } = await import('postcss');
  const { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });
  const accounts = [
    { id: 8, username: 'worker', displayName: '接手标注员', status: 'ACTIVE', role: 'USER', copyReviewEnabled: true },
    { id: 9, username: 'inactive', displayName: '已停用账号', status: 'DISABLED', role: 'USER', copyReviewEnabled: true },
    { id: 10, username: 'reader', displayName: '无标注权限', status: 'ACTIVE', role: 'USER', copyReviewEnabled: false },
  ];
  let cases = createCases();
  let partialFailure = false;
  let failNetwork = false;
  let failAccounts = false;
  let emptyAccounts = false;
  let incompleteReset = false;
  const requests = [], errors = [], unexpected = [];
  const reset = (count = 5) => {
    cases = createCases(count); partialFailure = false; failNetwork = false;
    failAccounts = false; emptyAccounts = false; incompleteReset = false; requests.length = 0;
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/bundle.js') { response.setHeader('content-type', 'application/javascript'); response.end(js); return; }
      if (url.pathname === '/bundle.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
      if (!url.pathname.startsWith('/api/')) {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body style="padding:24px"><main id="root"></main><script src="/bundle.js"></script></body></html>');
        return;
      }
      const reply = data => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data })); };
      if (url.pathname === '/api/control-plane/v1/users') {
        if (failAccounts) {
          response.statusCode = 503; response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ error: { code: 'ACCOUNTS_UNAVAILABLE', message: '测试账号读取失败，请重试' } })); return;
        }
        reply(emptyAccounts ? accounts.slice(1) : accounts); return;
      }
      if (url.pathname === apiRoot && request.method === 'GET') {
        const status = url.searchParams.get('status'), offset = Number(url.searchParams.get('offset'));
        const items = cases.filter(item => status === 'ALL' || item.status === status);
        reply({ items: items.slice(offset, offset + Number(url.searchParams.get('limit'))), total: items.length }); return;
      }
      if (url.pathname === `${apiRoot}/batch` && request.method === 'POST') {
        let raw = ''; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw); requests.push(body);
        if (failNetwork) { request.socket.destroy(); return; }
        const results = body.items.map(input => {
          const item = cases.find(candidate => candidate.id === input.id);
          if (partialFailure && input.id === 12) return { id: input.id, success: false,
            error: { code: 'VERSION_CONFLICT', message: '测试任务已由其他管理员修改，请刷新后重试' } };
          assert.ok(item, `batch request uses case ID ${input.id}`);
          assert.equal(input.expectedVersion, item.version);
          assert.match(input.requestId, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i);
          if (body.operation === 'REASSIGN') item.status = 'REASSIGNED';
          else if (body.operation === 'DISCARD') item.status = 'DISCARDED';
          else if (body.operation === 'RESET') {
            if (!incompleteReset) Object.assign(item, {
              resetStatus: 'READY', cleanupStatus: 'COMPLETE', canAssign: true, resetError: null,
            });
          }
          else assert.fail(`unexpected batch operation ${body.operation}`);
          item.version++;
          return { id: input.id, success: true, item: structuredClone(item) };
        });
        const succeeded = results.filter(result => result.success).length;
        reply({ operation: body.operation, total: results.length, succeeded, failed: results.length - succeeded, results }); return;
      }
      unexpected.push(`${request.method} ${url.pathname}`);
      response.statusCode = 404; response.end(JSON.stringify({ error: { code: 'UNEXPECTED', message: 'Unexpected fixture request' } }));
    } catch (error) {
      errors.push(error.message);
      response.statusCode = 500; response.end(JSON.stringify({ error: { code: 'FIXTURE', message: error.message } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.REASSIGNMENT_BATCH_BROWSER_CHANNEL || 'msedge' });
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}/reassignment`;
    const check = taskId => page.getByRole('checkbox', { name: `选择任务 #${taskId}`, exact: true });
    const all = page.getByRole('checkbox', { name: '全选本页待处理任务', exact: true });
    const batchAssign = page.getByRole('button', { name: '批量分配', exact: true });
    const batchDiscard = page.getByRole('button', { name: '批量废弃', exact: true });
    const batchReset = page.getByRole('button', { name: '批量重试还原 / 清理', exact: true });
    const dialog = page.getByRole('dialog');
    const reason = dialog.getByLabel(/^处理原因/u);
    const closeDialog = async () => {
      if (await dialog.isVisible()) await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    };
    const openFresh = async (count = 5, options = {}) => {
      reset(count); failAccounts = !!options.failAccounts; emptyAccounts = !!options.emptyAccounts;
      incompleteReset = !!options.incompleteReset;
      await page.goto(origin); await check(101).waitFor();
    };

    await page.goto(origin);
    await check(101).waitFor();
    assert.equal(await batchAssign.isDisabled(), true);
    assert.equal(await batchDiscard.isDisabled(), true);
    assert.equal(await batchReset.isDisabled(), true);
    assert.equal(await check(104).isDisabled(), true, 'regeneration cannot be selected for a competing operation');
    await check(101).check();
    await page.getByText('已选 1 条', { exact: true }).waitFor();
    assert.equal(await all.evaluate(node => node.indeterminate), true);
    await all.check();
    await page.getByText('已选 29 条', { exact: true }).waitFor();
    assert.equal(await check(104).isChecked(), false);
    assert.equal(await all.evaluate(node => node.indeterminate), false);
    assert.equal(await all.isChecked(), true);
    assert.equal(await batchAssign.isDisabled(), true, 'blocked rows prevent assigning a mixed selection');
    assert.equal(await batchDiscard.isDisabled(), false);
    assert.equal(await batchReset.isDisabled(), false);
    await page.getByRole('button', { name: '清空选择', exact: true }).click();
    assert.equal(await check(101).isChecked(), false);
    await check(101).check();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await check(131).waitFor();
    assert.equal(await check(131).isChecked(), false, 'moving pages clears selection');
    assert.equal(await batchDiscard.isDisabled(), true);
    await check(131).check();
    await page.getByRole('button', { name: '全部记录', exact: true }).click();
    await check(101).waitFor();
    assert.equal(await check(101).isChecked(), false, 'changing filters clears selection');
    assert.equal(await batchDiscard.isDisabled(), true);
    await page.getByRole('button', { name: '待处理', exact: true }).click();

    await openFresh();
    await check(101).check(); await check(102).check();
    await page.screenshot({ path: join(directory, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(directory, 'narrow.png'), fullPage: true });
    const horizontal = await page.evaluate(() => ({ viewport: window.innerWidth, page: document.documentElement.scrollWidth }));
    assert.ok(horizontal.page <= horizontal.viewport + 1, `page must contain horizontal table scrolling: ${JSON.stringify(horizontal)}`);
    await batchAssign.click();
    await dialog.getByRole('heading', { name: '批量分配 2 条任务', exact: true }).waitFor();
    const assign = dialog.getByRole('button', { name: '确认批量分配', exact: true });
    assert.equal(await assign.isDisabled(), true, 'assignment requires an account and a reason');
    await reason.fill('   ');
    assert.equal(await assign.isDisabled(), true, 'whitespace does not satisfy a mandatory reason');
    await reason.fill('同一批任务统一移交给新标注员。');
    assert.equal(await assign.isDisabled(), true, 'assignment still requires an eligible account');
    await dialog.getByLabel('接手账号', { exact: true }).click();
    assert.equal(await page.getByRole('option', { name: /已停用账号/u }).count(), 0);
    assert.equal(await page.getByRole('option', { name: /无标注权限/u }).count(), 0);
    await page.getByRole('option', { name: '接手标注员（worker）', exact: true }).click();
    assert.equal(await assign.isDisabled(), false);
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= 391, JSON.stringify(bounds));
    await page.screenshot({ path: join(directory, 'dialog-narrow.png'), fullPage: true });
    await assign.click();
    await check(101).waitFor({ state: 'detached' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].operation, 'REASSIGN');
    assert.equal(requests[0].targetAccountId, 8);
    assert.equal(requests[0].note, '同一批任务统一移交给新标注员。');
    assert.deepEqual(requests[0].items.map(({ id, expectedVersion }) => ({ id, expectedVersion })),
      [{ id: 11, expectedVersion: 3 }, { id: 12, expectedVersion: 4 }]);
    assert.equal(new Set(requests[0].items.map(item => item.requestId)).size, 2, 'each case has its own idempotency key');
    await closeDialog();

    await page.setViewportSize({ width: 1440, height: 1080 });
    await openFresh(5, { failAccounts: true });
    await check(101).check(); await batchAssign.click();
    await dialog.getByText(/测试账号读取失败，请重试/u).waitFor();
    await reason.fill('账号服务恢复后继续分配。');
    assert.equal(await dialog.getByLabel('接手账号', { exact: true }).isDisabled(), true);
    assert.equal(await assign.isDisabled(), true, 'failed account loading blocks assigning');
    failAccounts = false;
    await dialog.getByRole('button', { name: '重新加载账号', exact: true }).click();
    await dialog.getByLabel('接手账号', { exact: true }).click();
    await page.getByRole('option', { name: '接手标注员（worker）', exact: true }).click();
    assert.equal(await assign.isDisabled(), false, 'retrying account loading recovers the form without losing the reason');
    await closeDialog();
    assert.equal(requests.length, 0, 'cancelling a prepared batch performs no writes');
    await openFresh(5, { emptyAccounts: true });
    await check(101).check(); await batchAssign.click();
    await dialog.getByText(/暂无可用账号，请先在用户管理中启用具有标注权限的账号/u).waitFor();
    await reason.fill('没有接手账号时保持任务待处理。');
    assert.equal(await assign.isDisabled(), true);
    await closeDialog();

    await openFresh(); partialFailure = true;
    await check(101).check(); await check(102).check();
    await batchDiscard.click();
    await dialog.getByRole('heading', { name: '批量废弃 2 条任务', exact: true }).waitFor();
    const discard = dialog.getByRole('button', { name: '确认批量废弃', exact: true });
    assert.equal(await discard.isDisabled(), true, 'discard requires an audit reason');
    await reason.fill('不再进入生产，批量废弃。'); await discard.click();
    await page.getByText(/测试任务已由其他管理员修改，请刷新后重试/u).first().waitFor();
    await closeDialog();
    await check(101).waitFor({ state: 'detached' });
    assert.equal(await check(102).isChecked(), true, 'failed cases remain selected');
    await page.getByText('已选 1 条', { exact: true }).waitFor();
    assert.equal(requests[0].operation, 'DISCARD');
    await page.screenshot({ path: join(directory, 'partial-failure.png'), fullPage: true });
    partialFailure = false;
    await batchDiscard.click(); await reason.fill('刷新状态后重试失败任务。'); await discard.click();
    await check(102).waitFor({ state: 'detached' });
    assert.deepEqual(requests[1].items.map(item => item.id), [12], 'retrying partial results only sends the failed selection');

    await openFresh();
    await check(103).check();
    assert.equal(await batchAssign.isDisabled(), true);
    await batchReset.click();
    const retryReset = dialog.getByRole('button', { name: '确认批量重试', exact: true });
    await retryReset.waitFor();
    assert.equal(await retryReset.isDisabled(), false, 'repair can run without an audit reason');
    await retryReset.click();
    await closeDialog();
    await page.waitForFunction(() => [...document.querySelectorAll('tr')]
      .some(row => row.textContent.includes('#103') && row.textContent.includes('可分配')));
    assert.equal(requests[0].operation, 'RESET');
    assert.equal(requests[0].items[0].id, 13);
    assert.equal(await check(103).isChecked(), false, 'successful repair clears selection');

    await openFresh(5, { incompleteReset: true });
    await check(103).check(); await batchReset.click(); await retryReset.click();
    await closeDialog();
    const results = page.getByRole('region', { name: '批量处理结果', exact: true });
    await results.getByText('查看 1 条处理结果', { exact: true }).click();
    await results.getByText('未找到可信机器初稿，需要重试还原', { exact: true }).waitFor();
    assert.equal(await check(103).isChecked(), false, 'a processed but still-blocked reset is not silently resubmitted');
    await check(103).check();
    assert.equal(await batchAssign.isDisabled(), true, 'successful reset transport does not bypass preparation gates');

    await openFresh(); failNetwork = true;
    await check(101).check(); await check(102).check();
    await batchDiscard.click();
    await reason.fill('网络重试继续使用同一批处理标识。');
    await discard.click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(await reason.inputValue(), '网络重试继续使用同一批处理标识。');
    assert.equal(await discard.isDisabled(), false);
    const failedTransmissions = requests.length;
    assert.ok(failedTransmissions >= 1);
    failNetwork = false;
    await discard.click();
    await check(101).waitFor({ state: 'detached' });
    assert.equal(requests.length, failedTransmissions + 1);
    assert.ok(requests.every(request => JSON.stringify(request) === JSON.stringify(requests[0])),
      'browser transport retries and the user retry preserve versions, payload and every per-case request ID');
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    console.log(`reassignment batch screenshots: ${directory}`);
  } catch (error) {
    if (page) await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
