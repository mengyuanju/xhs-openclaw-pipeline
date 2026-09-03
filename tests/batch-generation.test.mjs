import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  parseBatchCopyGenerationIds,
  parseBatchQueries,
  parseBatchReferenceUrls,
  selectApprovedCopyGenerations,
} from '../src/batch-generation.mjs';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('batch generation input', () => {
  it('normalizes one query per line while preserving input order', () => {
    assert.deepEqual(
      parseBatchQueries('  第一个选题  \n\n第二个选题\r\n 第三个选题 '),
      ['第一个选题', '第二个选题', '第三个选题'],
    );
  });

  it('requires 2–20 unique queries with the single-generation length limit', () => {
    assert.throws(() => parseBatchQueries('只有一个选题'), /2–20/u);
    assert.throws(
      () => parseBatchQueries(Array.from({ length: 21 }, (_, index) => `选题 ${index + 1}`).join('\n')),
      /2–20/u,
    );
    assert.throws(() => parseBatchQueries('重复选题\n重复选题'), /重复/u);
    assert.throws(() => parseBatchQueries(`${'长'.repeat(501)}\n正常选题`), /500/u);
  });

  it('normalizes and validates the shared reference URL list', () => {
    assert.deepEqual(
      parseBatchReferenceUrls(' https://example.com/a \nhttps://example.com/a\nhttp://example.com/b'),
      ['https://example.com/a', 'http://example.com/b'],
    );
    assert.throws(() => parseBatchReferenceUrls('ftp://example.com/file'), /HTTP\(S\)/u);
    assert.throws(() => parseBatchReferenceUrls('https://user:secret@example.com'), /HTTP\(S\)/u);
  });

  it('accepts 1–20 unique approved copy record ids for batch images', () => {
    assert.deepEqual(parseBatchCopyGenerationIds([3, 1, 3]), [3, 1]);
    assert.throws(() => parseBatchCopyGenerationIds([]), /1–20/u);
    assert.throws(() => parseBatchCopyGenerationIds([0]), /正整数/u);
    assert.throws(
      () => parseBatchCopyGenerationIds(Array.from({ length: 21 }, (_, index) => index + 1)),
      /1–20/u,
    );
  });

  it('keeps only manually approved copy records for batch images', () => {
    const approved = { id: 2, manualReview: { decision: 'APPROVED' } };
    assert.deepEqual(selectApprovedCopyGenerations([
      { id: 1, manualReview: null },
      approved,
      { id: 3, manualReview: { decision: 'REJECTED' } },
    ]), [approved]);
  });
});

describe('separate batch generation workspaces', () => {
  it('adds separate batch copy and image modes while retaining the old URL as a redirect', async () => {
    const [navigation, topbar, legacyPage, batchCopyPage, batchImagePage, copyPage, imagePage] = await Promise.all([
      source('app/components/side-nav.tsx'),
      source('app/components/app-topbar.tsx'),
      source('app/batch-generation/page.tsx'),
      source('app/batch-copy-generation/page.tsx'),
      source('app/batch-image-generation/page.tsx'),
      source('app/copy-generation/page.tsx'),
      source('app/image-generation/page.tsx'),
    ]);

    assert.match(navigation, /href: '\/batch-copy-generation', label: '批量生成文案'/u);
    assert.match(navigation, /href: '\/batch-image-generation', label: '批量生成图片'/u);
    assert.doesNotMatch(navigation, /label: '批量生成图文'/u);
    assert.match(navigation, /href: '\/copy-generation', label: '单独生成文案'/u);
    assert.match(navigation, /href: '\/image-generation', label: '单独生成图片'/u);
    assert.match(topbar, /pathname\.startsWith\('\/batch-copy-generation'\)[\s\S]*title: '批量生成文案'/u);
    assert.match(topbar, /pathname\.startsWith\('\/batch-image-generation'\)[\s\S]*title: '批量生成图片'/u);
    assert.match(legacyPage, /redirect\('\/batch-copy-generation'\)/u);
    assert.match(batchCopyPage, /<h1>批量生成文案<\/h1>/u);
    assert.match(batchImagePage, /<h1>批量生成图片<\/h1>/u);
    assert.match(copyPage, /<CopyGenerationWorkbench/u);
    assert.match(imagePage, /<ImageGenerationWorkbench/u);
  });

  it('batch copy generation stops after saving copy for manual review', async () => {
    const [workbench, results] = await Promise.all([
      source('app/batch-copy-generation/batch-copy-generation-workbench.tsx'),
      source('app/batch-copy-generation/batch-copy-generation-results.tsx'),
    ]);

    assert.match(workbench, /^'use client';/u);
    assert.match(workbench, /for \(const \[index, query\] of queries\.entries\(\)\)/u);
    assert.match(workbench, /apiRequest<CopyGenerationResult>\('\/api\/copy-generations'/u);
    assert.doesNotMatch(workbench, /\/api\/image-generations/u);
    assert.match(workbench, /confirmation: 'LIVE_MODEL_COST_ACCEPTED'/u);
    assert.match(workbench, /catch \(error\)[\s\S]*continue;/u);
    assert.match(workbench, /\/api\/copy-generations\?page=1&pageSize=50/u);
    assert.match(workbench, /record\.manualReview === null/u);
    assert.match(workbench, /htmlFor="batch-copy-name"/u);
    assert.match(workbench, /createRunId\(\)/u);
    assert.match(workbench, /batch:\s*\{\s*id:\s*batchId,\s*name:\s*resolvedBatchName\s*\}/u);
    assert.match(workbench, /batchId=/u);
    assert.match(workbench, /response\.batches/u);
    assert.match(workbench, /response\.jobs/u);
    assert.match(workbench, /查看历史批次/u);
    assert.match(results, /batchName/u);
    assert.match(workbench, /\/manual-review/u);
    assert.match(results, /待人工质检/u);
    assert.match(results, /人工质检通过/u);
    assert.match(results, /item\.copyResult\.imagePlan\.map/u);
    assert.match(results, /配图策划/u);
    assert.match(results, /href="\/batch-image-generation"/u);
  });

  it('batch image generation lists only manually approved copies and never generates copy', async () => {
    const [workbench, results] = await Promise.all([
      source('app/batch-image-generation/batch-image-generation-workbench.tsx'),
      source('app/batch-image-generation/batch-image-generation-results.tsx'),
    ]);

    assert.match(workbench, /^'use client';/u);
    assert.match(workbench, /\/api\/copy-generations\?page=1&pageSize=50/u);
    assert.match(workbench, /selectApprovedCopyGenerations/u);
    assert.match(workbench, /parseBatchCopyGenerationIds/u);
    assert.match(workbench, /apiRequest<ImageGenerationResult>\('\/api\/image-generations'/u);
    assert.doesNotMatch(workbench, /method: 'POST'[\s\S]{0,160}\/api\/copy-generations/u);
    assert.match(workbench, /confirmation: 'LIVE_IMAGE_COST_ACCEPTED'/u);
    assert.match(workbench, /mode: 'LIVE'/u);
    assert.doesNotMatch(workbench, /Mock|MOCK/u);
    assert.match(workbench, /useImageGenerationHistory/u);
    assert.match(workbench, /useImageGenerationHistory\(\{ pollWhile: busy \}\)/u);
    assert.match(workbench, /<ImageGenerationHistory/u);
    assert.match(workbench, /<ImageGenerationHistory[\s\S]{0,320}disabled=\{busy\}/u);
    assert.match(workbench, /runId: nextRunId/u);
    assert.match(results, /图片已完成/u);
    assert.match(results, /打开首图/u);
    assert.match(results, /查看运行记录/u);
    assert.match(results, /runId[\s\S]{0,180}target="_blank"/u);
  });

  it('renders accessible inputs, quality gates, progress, stop and result states', async () => {
    const [copyWorkbench, copyResults, imageWorkbench, imageResults, styles] = await Promise.all([
      source('app/batch-copy-generation/batch-copy-generation-workbench.tsx'),
      source('app/batch-copy-generation/batch-copy-generation-results.tsx'),
      source('app/batch-image-generation/batch-image-generation-workbench.tsx'),
      source('app/batch-image-generation/batch-image-generation-results.tsx'),
      source('app/globals.css'),
    ]);
    const interfaceSource = `${copyWorkbench}\n${copyResults}\n${imageWorkbench}\n${imageResults}`;

    assert.match(copyWorkbench, /htmlFor="batch-copy-queries"/u);
    assert.match(copyWorkbench, /htmlFor="batch-copy-image-count"/u);
    assert.match(copyWorkbench, /确认批量生成文案/u);
    assert.match(imageWorkbench, /aria-label="选择全部已质检文案"/u);
    assert.doesNotMatch(imageWorkbench, /Mock|MOCK|batch-image-mode/u);
    assert.match(imageWorkbench, /真实图片并执行 OCR 与质量检查/u);
    assert.match(imageWorkbench, /仅显示人工质检通过的文案/u);
    assert.match(interfaceSource, /完成当前条后停止/u);
    assert.match(interfaceSource, /<progress/u);
    assert.match(interfaceSource, /aria-live="polite"/u);
    assert.match(interfaceSource, /role="alert"/u);
    assert.match(interfaceSource, /批量文案已完成/u);
    assert.match(interfaceSource, /批量图片已完成/u);
    assert.match(interfaceSource, /生成失败/u);
    assert.match(styles, /\.batch-generation-workspace/u);
    assert.match(styles, /\.batch-generation-list/u);
    assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.batch-generation/u);
  });
});
