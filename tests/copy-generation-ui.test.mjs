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
    const workbench = await source('app/copy-generation/copy-generation-workbench.tsx');

    assert.match(workbench, /^'use client';/u);
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
    assert.match(workbench, /navigator\.clipboard\.writeText/u);
    assert.match(workbench, /result\.copy\.title/u);
    assert.match(workbench, /result\.copy\.body/u);
    assert.match(workbench, /result\.copy\.tags/u);
    assert.doesNotMatch(workbench, /<select\b/u);
    assert.doesNotMatch(workbench, /runImage|image-generations/u);
  });
});
