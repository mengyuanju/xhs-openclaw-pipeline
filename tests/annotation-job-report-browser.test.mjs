import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

test('annotation job report toggles quality-only records, explains statistics and switches one chart across four metrics', {
  skip: process.env.RUN_ANNOTATION_JOB_REPORT_BROWSER !== '1', timeout: 120_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'annotation-job-report-browser-'));
  let server;
  let browser;
  const requests=[];
  const unexpected=[];
  try {
    await build({
      stdin: { contents: `import './app/globals.css';import React from 'react';import{createRoot}from'react-dom/client';
        import{getInstanceByDom}from'echarts/core';
        import{AnnotationJobReport}from'./app/reports/annotation-jobs/report';
        window.__annotationTrendChart=()=>{const element=document.querySelector('[role="img"][aria-label*="每日趋势"]');
          return element?getInstanceByDom(element):null};
        createRoot(document.getElementById('root')).render(<AnnotationJobReport initialFilters={{from:'2026-09-28',to:'2026-10-01',accountId:''}}/>);`,
      resolveDir: process.cwd(), loader: 'tsx' },
      bundle: true, outfile: join(root, 'bundle.js'), jsx: 'automatic', platform: 'browser', conditions: ['style'],
      alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [{ name: 'next-dynamic-stub', setup(plugin) {
        plugin.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: 'next/dynamic', namespace: 'next-stub' }));
        plugin.onLoad({ filter: /.*/, namespace: 'next-stub' }, () => ({ loader: 'jsx', resolveDir: process.cwd(),
          contents: `import React,{lazy,Suspense}from'react';export default function dynamic(loader){
            const Component=lazy(loader);return props=><Suspense fallback={<span>图表加载中</span>}><Component {...props}/></Suspense>}` }));
      } }],
    });
    const [bundle, rawCss] = await Promise.all([
      readFile(join(root, 'bundle.js')), readFile(join(root, 'bundle.css'), 'utf8'),
    ]);
    const { default: postcss } = await import('postcss');
    const { default: tailwind } = await import('@tailwindcss/postcss');
    const { css } = await postcss([tailwind()]).process(rawCss,
      { from: join(process.cwd(), 'app/globals.css') });
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
      range: { from: '2026-09-28', to: '2026-10-01' }, asOf: '2026-10-01T12:00:00Z',
      summary: { workers: 2, totalJobs: 5, returned: 2 },
      people: [person(11, '标注甲', 3, 2, 1, 1, 2), person(22, '标注乙', 2, 1, 0, 0, 1),
        { ...person(33, '仅质检记录夹具', 0, 0, 0, 0, 2), returned: 2 }],
      trend: { dates: ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'], rows: [
        { date: '2026-09-28', accountId: 11, totalJobs: 1, copyReview: 1, imageFirstReview: 0,
          copyFirstPassed: 1, copyDecided: 1, copyFirstPassRate: 1 },
        { date: '2026-09-29', accountId: 11, totalJobs: 0, copyReview: 0, imageFirstReview: 0,
          copyFirstPassed: 0, copyDecided: 0, copyFirstPassRate: null },
        { date: '2026-09-30', accountId: 22, totalJobs: 2, copyReview: 1, imageFirstReview: 0,
          copyFirstPassed: 0, copyDecided: 1, copyFirstPassRate: 0 },
        { date: '2026-10-01', accountId: 11, totalJobs: 2, copyReview: 1, imageFirstReview: 1,
          copyFirstPassed: 0, copyDecided: 1, copyFirstPassRate: 0 },
      ] },
      dataQuality: { unknownIdentity: 0, unattributedAnnotationBatchReturns: 0,
        unattributedAnnotationBatchScopes: 0 },
    };
    server = createServer((request, response) => {
      if (request.url === '/bundle.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(bundle); return; }
      if (request.url === '/bundle.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return; }
      if (request.url?.startsWith('/api/')) {
        requests.push(request.url);
        if(request.method!=='GET'||!['/api/control-plane/v1/users','/api/control-plane/v1/admin/annotation-job-report'].includes(new URL(request.url,'http://fixture').pathname)){
          unexpected.push(`${request.method} ${request.url}`);response.statusCode=400;response.end('{}');return;
        }
        const data = request.url.includes('/users') ? report.people.map(({ accountId, username, displayName }) =>
          ({ id: accountId, username, displayName })) : report;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ data }));
        return;
      }
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/bundle.css"></head><body><main class="main-shell" id="root"></main>
        <script src="/bundle.js"></script></body></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/reports/annotation-jobs`);
    const panel = page.getByRole('region', { name: '标注作业图形统计' });
    const tabs = panel.getByRole('tablist', { name: '图形统计分类' }).getByRole('tab');
    await tabs.first().waitFor();
    const results=page.getByRole('region',{name:'标注人作业列表',exact:true});
    const qualityOnly=results.getByRole('row').filter({hasText:'仅质检记录夹具'});
    const showQuality=results.getByRole('button',{name:'查看仅有质检记录（1）',exact:true});
    assert.equal(await showQuality.getAttribute('aria-expanded'),'false');
    assert.equal(await qualityOnly.count(),0,'quality-only people are omitted from the initial working-person table');
    await results.getByText('2 位有作业 · 1 位仅有质检记录',{exact:false}).waitFor();
    await showQuality.click();
    await qualityOnly.waitFor();
    assert.equal(await results.getByRole('button',{name:'隐藏仅有质检记录',exact:true}).getAttribute('aria-expanded'),'true');
    assert.equal(await qualityOnly.getByRole('cell').nth(1).textContent(),'0');
    await qualityOnly.getByText('本期无作业 · 仅质检记录',{exact:true}).waitFor();
    assert.equal(await panel.getByText('2 位有作业的标注人',{exact:true}).count(),1,'quality-only table disclosure does not add a trend line');
    await results.getByRole('button',{name:'隐藏仅有质检记录',exact:true}).click();
    assert.equal(await qualityOnly.count(),0);
    const methods=results.locator('details');
    assert.equal(await methods.getAttribute('open'),null);
    await methods.getByText('统计口径',{exact:true}).click();
    assert.equal(await methods.evaluate(element=>element.open),true);
    await methods.getByText(/仅有质检结论、没有本期作业/u).waitFor();
    await methods.getByText(/文案一次通过率按所选日期内首次文案作业对应/u).waitFor();
    if (process.env.ANNOTATION_JOB_REPORT_SCREENSHOT) {
      await showQuality.click(); await qualityOnly.waitFor();
      await page.screenshot({ path: process.env.ANNOTATION_JOB_REPORT_SCREENSHOT.replace(/\.png$/iu,'-quality-only.png'), fullPage:true });
      await results.getByRole('button',{name:'隐藏仅有质检记录',exact:true}).click();
      assert.equal(await qualityOnly.count(),0);
    }
    await methods.getByText('统计口径',{exact:true}).click();
    assert.equal(await methods.evaluate(element=>element.open),false);
    assert.deepEqual(await tabs.allTextContents(),
      ['总作业', '首次文案审核', '文案一次通过率', '首次图片审核']);
    await page.waitForFunction(() => document.querySelectorAll('canvas').length === 1);
    assert.equal(await panel.locator('canvas').count(), 1);
    assert.ok(await panel.locator('canvas').first().evaluate(canvas => canvas.width > 0 && canvas.height > 0));
    assert.ok(requests.filter(path=>path.includes('/annotation-job-report')).every(path=>!new URL(path,'http://fixture').searchParams.has('refresh')),'initial annotation reads use shared cache');
    await showQuality.click();
    await qualityOnly.waitFor();
    await Promise.all([page.waitForResponse(response=>new URL(response.url()).searchParams.get('refresh')==='true'),
      page.getByRole('button',{name:'刷新',exact:true}).click()]);
    await page.getByRole('button',{name:'刷新',exact:true}).waitFor();
    await showQuality.waitFor();
    assert.equal(await showQuality.getAttribute('aria-expanded'),'false','refresh resets the optional quality-only disclosure');
    assert.equal(await qualityOnly.count(),0);
    const valueToggle = panel.getByRole('button', { name: '显示数值' });
    assert.equal(await valueToggle.getAttribute('aria-pressed'), 'true');
    const initialLabels = await page.evaluate(() => {
      const series = window.__annotationTrendChart()?.getOption().series;
      return series?.map(item => ({ show: item.label?.show, showSymbol: item.showSymbol,
        showAllSymbol: item.showAllSymbol, first: item.label?.formatter?.({ dataIndex: 0 }),
        second: item.label?.formatter?.({ dataIndex: 1 }) }));
    });
    assert.deepEqual(initialLabels, [
      { show: true, showSymbol: true, showAllSymbol: true, first: '1', second: '0' },
      { show: true, showSymbol: true, showAllSymbol: true, first: '0', second: '2' },
    ], 'count labels should show the integer value at every point, including zero');
    const dateView = panel.getByRole('group', { name: '图表日期视角' });
    const workedDays = dateView.getByRole('button', { name: '有作业日' });
    const calendarDays = dateView.getByRole('button', { name: '自然日' });
    assert.equal(await workedDays.getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => window.__annotationTrendChart()
      ?.getOption().xAxis?.[0]?.data?.length === 3);
    assert.deepEqual(await page.evaluate(() => window.__annotationTrendChart().getOption().xAxis[0].data),
      ['2026-09-28', '2026-09-30', '2026-10-01'],
      'the default view should fold the all-person idle date');
    await panel.getByText('显示 3 天，折叠 1 天无作业日期',{exact:true}).waitFor();
    const metrics = [
      ['总作业', '5 次'], ['首次文案审核', '3 次'],
      ['文案一次通过率', '33.33%'], ['首次图片审核', '1 次'],
    ];
    for (const [label, value] of metrics) {
      const tab = panel.getByRole('tab', { name: label });
      await tab.click();
      assert.equal(await tab.getAttribute('data-state'), 'active');
      assert.equal(await panel.locator('[data-slot="metric-period-value"]').textContent(), value);
      assert.match(await panel.getByRole('img', { name: /每日趋势/u }).getAttribute('aria-label'),
        new RegExp(label, 'u'));
      assert.equal(await panel.locator('canvas').count(), 1);
    }
    await panel.getByRole('tab', { name: '文案一次通过率' }).click();
    const rateSemantics = await page.evaluate(() => {
      const chart = window.__annotationTrendChart();
      const option = chart?.getOption();
      const first = option?.series?.[0];
      const tooltip = option?.tooltip?.[0]?.formatter;
      return { connectNulls: first?.connectNulls, values: first?.data,
        labelShow: first?.label?.show, firstLabel: first?.label?.formatter?.({ dataIndex: 0 }),
        missingLabel: first?.label?.formatter?.({ dataIndex: 1 }),
        missingTooltip: tooltip?.([{ seriesIndex: 0, dataIndex: 1 }]) };
    });
    assert.equal(rateSemantics.connectNulls, true,
      'a missing rate between two valid days should not break the line');
    assert.deepEqual(rateSemantics.values, [100, null, 0]);
    assert.equal(rateSemantics.labelShow, true);
    assert.equal(rateSemantics.firstLabel, '100%');
    assert.equal(rateSemantics.missingLabel, '', 'an undefined rate must not get a point label');
    assert.match(rateSemantics.missingTooltip, /标注甲[^\n]*—/u,
      'the tooltip should identify an undefined rate as unavailable');
    assert.doesNotMatch(rateSemantics.missingTooltip, /0\.00%/u,
      'the tooltip must not present a missing rate as zero percent');
    await panel.getByRole('tab', { name: '总作业' }).click();
    await valueToggle.click();
    assert.equal(await valueToggle.getAttribute('aria-pressed'), 'false');
    await page.waitForFunction(() => window.__annotationTrendChart()
      ?.getOption().series?.every(item => item.label?.show === false));
    assert.equal(await page.evaluate(() => window.__annotationTrendChart()
      .getOption().series.every(item => item.showAllSymbol === false)), true);
    await panel.getByRole('tab', { name: '首次图片审核' }).click();
    assert.equal(await valueToggle.getAttribute('aria-pressed'), 'false',
      'the label display choice should survive switching metric tabs');
    await valueToggle.click();
    assert.equal(await valueToggle.getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => window.__annotationTrendChart()
      ?.getOption().series?.every(item => item.label?.show === true));
    await panel.getByRole('tab', { name: '总作业' }).click();
    assert.equal(await valueToggle.getAttribute('aria-pressed'), 'true');
    if (process.env.ANNOTATION_JOB_REPORT_SCREENSHOT) {
      await page.screenshot({ path: process.env.ANNOTATION_JOB_REPORT_SCREENSHOT, fullPage: true });
    }
    await panel.getByText('图中显示 2 / 2 人').waitFor();
    const legendSelectors = await page.evaluate(() => window.__annotationTrendChart()
      ?.getOption().legend?.[0]?.selector?.map(item => ({ type: item.type, title: item.title })));
    assert.deepEqual(legendSelectors, [
      { type: 'all', title: '全选' }, { type: 'inverse', title: '反选' },
    ]);
    async function clickLegendText(label) {
      const point = await page.evaluate(text => {
        const chart = window.__annotationTrendChart();
        const displayList = chart?.getZr().storage.getDisplayList();
        const element = displayList?.find(item => item.style?.text === text);
        if (!element) return { list: displayList?.filter(item => item.style?.text).map(item => ({ type: item.type, text: item.style.text })) };
        const rect = element.getBoundingRect().clone();
        rect.applyTransform(element.getComputedTransform());
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }, label);
      assert.ok(point?.x != null, `ECharts should render a clickable ${label} legend label: ${JSON.stringify(point)}`);
      await panel.locator('canvas').click({ position: point });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    await clickLegendText('反选');
    await panel.getByText('图中显示 0 / 2 人').waitFor();
    await clickLegendText('全选');
    await panel.getByText('图中显示 2 / 2 人').waitFor();
    await clickLegendText('标注乙 · #22');
    await panel.getByText('图中显示 1 / 2 人').waitFor();
    assert.match(await panel.getByRole('img', { name: /每日趋势/u }).getAttribute('aria-label'),
      /当前显示 1 位人员/u);
    await panel.getByRole('tab', { name: '首次文案审核' }).click();
    await panel.getByText('图中显示 1 / 2 人').waitFor();
    await calendarDays.click();
    assert.equal(await calendarDays.getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => window.__annotationTrendChart()
      ?.getOption().xAxis?.[0]?.data?.length === 4);
    assert.deepEqual(await page.evaluate(() => window.__annotationTrendChart().getOption().xAxis[0].data),
      ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'],
      'the calendar view should restore the all-person idle date');
    await panel.getByText('显示全部 4 天，保留无作业日的零值',{exact:true}).waitFor();
    await panel.getByText('图中显示 1 / 2 人').waitFor();
    assert.equal(await page.evaluate(() => window.__annotationTrendChart()
      .getOption().legend[0].selected['标注乙 · #22']), false,
    'date-view switching should retain the hidden person');
    await workedDays.click();
    await page.waitForFunction(() => window.__annotationTrendChart()
      ?.getOption().xAxis?.[0]?.data?.length === 3);
    await panel.getByText('图中显示 1 / 2 人').waitFor();
    assert.equal(await panel.getByRole('button', { name: /选择人员/u }).count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await panel.getByRole('tab', { name: '总作业' }).waitFor();
    await panel.getByText('图中显示 2 / 2 人').waitFor();
    await page.waitForFunction(() => {
      const chart = document.querySelector('[aria-label="标注作业图形统计"] canvas');
      return chart && chart.getBoundingClientRect().width < innerWidth;
    });
    const tabRows = await tabs.evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, right: rect.right };
    }));
    assert.ok(tabRows[2].top > tabRows[0].top, 'narrow layout wraps metric tabs into two rows');
    assert.ok(tabRows.every(row => row.right <= 390), 'metric tabs stay within the narrow viewport');
    assert.equal(await panel.locator('canvas').count(), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      'narrow page has no horizontal overflow');
    if (process.env.ANNOTATION_JOB_REPORT_SCREENSHOT) {
      const path = process.env.ANNOTATION_JOB_REPORT_SCREENSHOT.replace(/\.png$/iu, '-narrow.png');
      await page.screenshot({ path, fullPage: true });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    assert.equal(new URL(requests.filter(path=>path.includes('/annotation-job-report')).at(-1),'http://fixture').searchParams.has('refresh'),false,'reload returns to ordinary cached report reads');
    console.log(JSON.stringify({scopeIds:['F-ANNOT-002','F-ANNOT-003','F-ANNOT-004'],qualityOnlyDisclosure:true,
      numericLabelsActuallyClicked:true,dateFoldingActuallyClicked:true,statisticsDisclosureActuallyClicked:true,
      httpWrites:0,paidModelCalls:0,originalHundredRowDatasetModified:false}));
  } finally {
    await browser?.close();
    await new Promise(resolve => server?.close(resolve) ?? resolve());
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`),'only remove verified temporary test directory');
    await rm(root, { recursive: true, force: true });
  }
});
