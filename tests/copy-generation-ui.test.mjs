import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('standalone copy generation workspace', () => {
  it('exposes a focused text-only workspace from the production navigation', async () => {
    const [navigation, topbar, page] = await Promise.all([
      source('app/components/side-nav.tsx'),
      source('app/components/app-topbar.tsx'),
      source('app/copy-generation/page.tsx'),
    ]);

    assert.match(navigation, /href: '\/copy-generation', label: '单独生成文案'/u);
    assert.match(topbar, /pathname\.startsWith\('\/copy-generation'\)/u);
    assert.match(page, /<h1>单独生成文案<\/h1>/u);
    assert.match(page, /不创建生产任务，也不生成图片/u);
    assert.match(page, /<CopyGenerationWorkbench/u);
  });

  it('submits the confirmed API contract and renders accessible operation states', async () => {
    const [workbench, historyState] = await Promise.all([
      source('app/copy-generation/copy-generation-workbench.tsx'),
      source('app/copy-generation/use-copy-generation-history.ts'),
    ]);

    assert.match(workbench, /^'use client';/u);
    assert.match(historyState, /useEffect/u);
    assert.match(historyState, /\/api\/copy-generations\?page=1&pageSize=20/u);
    assert.match(workbench, /apiRequest<CopyGenerationResult>\('\/api\/copy-generations'/u);
    assert.match(workbench, /confirmation: 'LIVE_MODEL_COST_ACCEPTED'/u);
    assert.match(workbench, /htmlFor="copy-query"/u);
    assert.match(workbench, /htmlFor="copy-category"/u);
    assert.match(workbench, /htmlFor="copy-audience"/u);
    assert.match(workbench, /htmlFor="copy-reference-text"/u);
    assert.match(workbench, /htmlFor="copy-reference-urls"/u);
    assert.match(workbench, /htmlFor="copy-image-count"/u);
    assert.match(workbench, /role=\{messageIsError \? 'alert' : 'status'\}/u);
    assert.match(workbench, /aria-live="polite"/u);
    assert.match(workbench, /generated\.reviewed\.review\.decision/u);
    assert.match(workbench, /质检仍未通过.*具体错误.*人工二次质检/u);
    assert.match(workbench, /CopyGenerationComparison/u);
    assert.match(workbench, /useCopyGenerationHistory/u);
    assert.match(workbench, /jobs=\{jobs\}/u);
    assert.match(workbench, /首稿审核通过后直接保存/u);
    assert.match(workbench, /只有存在阻断问题才调用第二次文案生成/u);
    assert.match(historyState, /hasRunningJobs/u);
    assert.match(historyState, /setInterval/u);
    assert.match(historyState, /response\.jobs/u);
    assert.doesNotMatch(workbench, /<select\b/u);
    assert.doesNotMatch(workbench, /runImage|image-generations/u);
  });

  it('renders persistent history and separate original/reviewed comparison controls', async () => {
    const [comparison, history, historyState, styles] = await Promise.all([
      source('app/copy-generation/copy-generation-comparison.tsx'),
      source('app/copy-generation/copy-generation-history.tsx'),
      source('app/copy-generation/use-copy-generation-history.ts'),
      source('app/globals.css'),
    ]);

    assert.match(comparison, /原始版/u);
    assert.match(comparison, /质检版/u);
    assert.match(comparison, /复制原始版/u);
    assert.match(comparison, /复制质检版/u);
    assert.match(comparison, /navigator\.clipboard\.writeText/u);
    assert.match(comparison, /result\.original\.copy/u);
    assert.match(comparison, /result\.reviewed\.copy/u);
    assert.match(comparison, /version\.review\.summary/u);
    assert.match(comparison, /version\.review\.issues/u);
    assert.match(comparison, /质检未通过，结果已保留/u);
    assert.match(comparison, /blockingIssues/u);
    assert.match(comparison, /人工二次质检/u);
    assert.match(comparison, /不能导入图片生成/u);
    assert.match(comparison, /disabled=\{!reviewedCopyPassed\}/u);
    assert.match(comparison, /version\.thinking/u);
    assert.match(comparison, /thinking：/u);
    assert.match(comparison, /总耗时/u);
    assert.match(comparison, /原始版生成/u);
    assert.match(comparison, /质检版复检/u);
    assert.match(comparison, /formatDuration/u);
    assert.match(history, /平均耗时/u);
    assert.match(history, /P50/u);
    assert.match(history, /P95/u);
    assert.match(history, /statistics\.sampleSize/u);
    assert.match(history, /生成任务/u);
    assert.match(history, /生成中/u);
    assert.match(history, /生成失败/u);
    assert.match(history, /待人工复核/u);
    assert.match(history, /aria-live="polite"/u);
    assert.match(historyState, /setTimingStatistics/u);
    assert.match(styles, /\.copy-generation-history/u);
    assert.match(styles, /\.copy-comparison-grid/u);
    assert.match(styles, /\.copy-timing-statistics/u);
    assert.match(styles, /\.copy-timing-breakdown/u);
    assert.match(styles, /\.copy-job-list/u);
    assert.match(styles, /\.copy-validation-notice/u);
    assert.match(styles, /\.copy-history-list \.pill-rejected/u);
  });
});
