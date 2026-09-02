import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  parseBatchQueries,
  parseBatchReferenceUrls,
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
});

describe('batch generation workspace', () => {
  it('adds a separate mode without replacing either standalone workflow', async () => {
    const [navigation, topbar, page, copyPage, imagePage] = await Promise.all([
      source('app/components/side-nav.tsx'),
      source('app/components/app-topbar.tsx'),
      source('app/batch-generation/page.tsx'),
      source('app/copy-generation/page.tsx'),
      source('app/image-generation/page.tsx'),
    ]);

    assert.match(navigation, /href: '\/batch-generation', label: '批量生成图文'/u);
    assert.match(navigation, /href: '\/copy-generation', label: '单独生成文案'/u);
    assert.match(navigation, /href: '\/image-generation', label: '单独生成图片'/u);
    assert.match(topbar, /pathname\.startsWith\('\/batch-generation'\)/u);
    assert.match(page, /<h1>批量生成图文<\/h1>/u);
    assert.match(page, /<BatchGenerationWorkbench/u);
    assert.match(copyPage, /<CopyGenerationWorkbench/u);
    assert.match(imagePage, /<ImageGenerationWorkbench/u);
  });

  it('reuses the single APIs sequentially and isolates per-item failures', async () => {
    const workbench = await source('app/batch-generation/batch-generation-workbench.tsx');
    const copyCall = workbench.indexOf("apiRequest<CopyGenerationResult>('/api/copy-generations'");
    const imageCall = workbench.indexOf("apiRequest<ImageGenerationResult>('/api/image-generations'");

    assert.match(workbench, /^'use client';/u);
    assert.match(workbench, /for \(const \[index, query\] of queries\.entries\(\)\)/u);
    assert.ok(copyCall > -1, 'batch mode should reuse the single copy API');
    assert.ok(imageCall > copyCall, 'image generation must follow copy generation');
    assert.match(workbench, /confirmation: 'LIVE_MODEL_COST_ACCEPTED'/u);
    assert.match(workbench, /confirmation: 'LIVE_IMAGE_COST_ACCEPTED'/u);
    assert.match(workbench, /catch \(error\)[\s\S]*continue;/u);
    assert.match(workbench, /createRunId\(\)/u);
  });

  it('renders accessible input, confirmation, progress, stop and result states', async () => {
    const [workbench, results, styles] = await Promise.all([
      source('app/batch-generation/batch-generation-workbench.tsx'),
      source('app/batch-generation/batch-generation-results.tsx'),
      source('app/globals.css'),
    ]);
    const interfaceSource = `${workbench}\n${results}`;

    assert.match(workbench, /htmlFor="batch-queries"/u);
    assert.match(workbench, /htmlFor="batch-image-count"/u);
    assert.match(workbench, /htmlFor="batch-image-mode"/u);
    assert.match(workbench, /确认批量生成/u);
    assert.match(interfaceSource, /完成当前条后停止/u);
    assert.match(interfaceSource, /<progress/u);
    assert.match(interfaceSource, /aria-live="polite"/u);
    assert.match(interfaceSource, /role="alert"/u);
    assert.match(interfaceSource, /批次已完成/u);
    assert.match(interfaceSource, /生成失败/u);
    assert.match(styles, /\.batch-generation-workspace/u);
    assert.match(styles, /\.batch-generation-list/u);
    assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.batch-generation/u);
  });
});
