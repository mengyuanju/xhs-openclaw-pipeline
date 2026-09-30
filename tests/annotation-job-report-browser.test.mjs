import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('annotation job trend renders four charts and keeps person selection in sync', {
  skip: process.env.RUN_ANNOTATION_JOB_REPORT_BROWSER !== '1', timeout: 120_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'annotation-job-report-browser-'));
  let server;
  let browser;
  try {
    await build({
      stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';
        import{AnnotationJobReport}from'./app/reports/annotation-jobs/report';
        createRoot(document.getElementById('root')).render(<AnnotationJobReport initialFilters={{from:'2026-09-28',to:'2026-09-30',accountId:''}}/>);`,
      resolveDir: process.cwd(), loader: 'tsx' },
      bundle: true, outfile: join(root, 'bundle.js'), jsx: 'automatic', platform: 'browser',
      alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [{ name: 'next-dynamic-stub', setup(plugin) {
        plugin.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: 'next/dynamic', namespace: 'next-stub' }));
        plugin.onLoad({ filter: /.*/, namespace: 'next-stub' }, () => ({ loader: 'jsx', resolveDir: process.cwd(),
          contents: `import React,{lazy,Suspense}from'react';export default function dynamic(loader){
            const Component=lazy(loader);return props=><Suspense fallback={<span>图表加载中</span>}><Component {...props}/></Suspense>}` }));
      } }],
    });
    const bundle = await readFile(join(root, 'bundle.js'));
    const css = await readFile(join(root, 'bundle.css'));
    const person = (accountId, name, jobs, review, image, passed, decided) => ({
      accountId, username: `worker-${accountId}`, displayName: name, totalJobs: jobs,
      copyReview: review, copyReviewTasks: review, copyFirstPassRate: decided ? passed / decided : 0,
      copyFirstPassed: passed, copyDecided: decided, copyFirstReturned: decided - passed,
      copyFirstQaDiscarded: 0, copyFirstUnjudged: 0, copyFirstDirectDiscarded: 0,
      copyFirstPending: 0, copyFirstBypassed: 0, copyFirstUnjudgedOther: 0,
      copyRework: jobs - review - image, copyReworkTasks: 0, copyReworkOfFirstTasks: 0,
      copyReworkOtherTasks: 0, imageFirstReview: image, imageRework: 0,
      imageReworkTasks: 0, discarded: 0, returned: 0,
    });
    const report = {
      range: { from: '2026-09-28', to: '2026-09-30' }, asOf: '2026-09-30T12:00:00Z',
      summary: { workers: 2, totalJobs: 5, returned: 0 },
      people: [person(11, '标注甲', 3, 2, 1, 1, 2), person(22, '标注乙', 2, 1, 0, 0, 1)],
      trend: { dates: ['2026-09-28', '2026-09-29', '2026-09-30'], rows: [
        { date: '2026-09-28', accountId: 11, totalJobs: 1, copyReview: 1, imageFirstReview: 0,
          copyFirstPassed: 1, copyDecided: 1, copyFirstPassRate: 1 },
        { date: '2026-09-29', accountId: 11, totalJobs: 2, copyReview: 1, imageFirstReview: 1,
          copyFirstPassed: 0, copyDecided: 1, copyFirstPassRate: 0 },
        { date: '2026-09-29', accountId: 22, totalJobs: 2, copyReview: 1, imageFirstReview: 0,
          copyFirstPassed: 0, copyDecided: 1, copyFirstPassRate: 0 },
      ] },
      dataQuality: { unknownIdentity: 0, unattributedAnnotationBatchReturns: 0,
        unattributedAnnotationBatchScopes: 0 },
    };
    server = createServer((request, response) => {
      if (request.url === '/bundle.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(bundle); return; }
      if (request.url === '/bundle.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return; }
      if (request.url?.startsWith('/api/')) {
        const data = request.url.includes('/users') ? report.people.map(({ accountId, username, displayName }) =>
          ({ id: accountId, username, displayName })) : report;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ data }));
        return;
      }
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/bundle.css"><style>:root{--ink:#222;--muted:#666;--line:#ddd;
        --surface:#f8f8f8;--panel:#fff;--control-border:#bbb;--control-bg:#fff;--red-dark:#a32c3b}
        body{font-family:sans-serif;margin:20px}</style></head><body><div id="root"></div>
        <script src="/bundle.js"></script></body></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/reports/annotation-jobs`);
    const panel = page.getByRole('region', { name: '标注作业图形统计' });
    await panel.getByText('显示 2 / 2 位标注人').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('canvas').length === 4);
    assert.deepEqual(await panel.locator('h3').allTextContents(),
      ['总作业', '首次文案审核', '文案一次通过率', '首次图片审核']);
    assert.equal(await panel.locator('canvas').count(), 4);
    assert.ok(await panel.locator('canvas').first().evaluate(canvas => canvas.width > 0 && canvas.height > 0));
    if (process.env.ANNOTATION_JOB_REPORT_SCREENSHOT) {
      await page.screenshot({ path: process.env.ANNOTATION_JOB_REPORT_SCREENSHOT, fullPage: true });
    }
    await panel.locator('summary').click();
    await panel.getByRole('checkbox', { name: /标注乙/u }).uncheck();
    await panel.getByText('显示 1 / 2 位标注人').waitFor();
    assert.doesNotMatch(await panel.getByRole('img', { name: /总作业每日趋势/u }).getAttribute('aria-label'), /标注乙/u);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server?.close(resolve) ?? resolve());
    await rm(root, { recursive: true, force: true });
  }
});
