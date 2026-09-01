import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('standalone image generation workspace', () => {
  it('is visible in the production navigation and has its own page', async () => {
    const [navigation, topbar, page] = await Promise.all([
      source('app/components/side-nav.tsx'),
      source('app/components/app-topbar.tsx'),
      source('app/image-generation/page.tsx'),
    ]);

    assert.match(navigation, /href: '\/image-generation', label: '单独生成图片'/u);
    assert.match(topbar, /pathname\.startsWith\('\/image-generation'\)/u);
    assert.match(page, /<h1>单独生成图片<\/h1>/u);
    assert.match(page, /不创建生产任务/u);
    assert.match(page, /<ImageGenerationWorkbench/u);
  });

  it('exposes the strict Mock/Live API contract and safe error codes', async () => {
    const route = await source('app/api/image-generations/route.ts');

    assert.match(route, /mode: z\.enum\(\['MOCK', 'LIVE'\]\)/u);
    assert.match(route, /validationCode: 'VALIDATION_ERROR'/u);
    assert.match(route, /LIVE_IMAGE_COST_ACCEPTED/u);
    assert.match(route, /IMAGE_GENERATION_IN_PROGRESS/u);
    assert.match(route, /LIVE_CONFIRMATION_REQUIRED/u);
    assert.match(route, /IMAGE_ALIGNMENT_FAILED/u);
    assert.match(route, /IMAGE_GENERATION_FAILED/u);
    assert.match(route, /generateStandaloneImages/u);
    assert.match(route, /createOpenClawClient/u);
  });

  it('renders labeled inputs, cost confirmation, loading, errors and image previews', async () => {
    const [workbench, styles] = await Promise.all([
      source('app/image-generation/image-generation-workbench.tsx'),
      source('app/globals.css'),
    ]);

    assert.match(workbench, /^'use client';/u);
    assert.match(workbench, /htmlFor="image-query"/u);
    assert.match(workbench, /htmlFor="image-title"/u);
    assert.match(workbench, /htmlFor="image-body"/u);
    assert.match(workbench, /htmlFor="image-tags"/u);
    assert.match(workbench, /htmlFor="image-plan"/u);
    assert.match(workbench, /htmlFor="image-mode"/u);
    assert.match(workbench, /LIVE_IMAGE_COST_ACCEPTED/u);
    assert.match(workbench, /确认调用真实图片模型/u);
    assert.match(workbench, /正在生成图片/u);
    assert.match(workbench, /role=\{messageIsError \? 'alert' : 'status'\}/u);
    assert.match(workbench, /result\.images\.map/u);
    assert.match(workbench, /<img/u);
    assert.match(styles, /\.standalone-image-workspace/u);
    assert.match(styles, /\.standalone-image-gallery/u);
  });

  it('polls a recoverable run and shows real stages, percentage and estimated time', async () => {
    const [route, statusRoute, workbench, progressView, runState, styles] = await Promise.all([
      source('app/api/image-generations/route.ts'),
      source('app/api/image-generations/[runId]/route.ts'),
      source('app/image-generation/image-generation-workbench.tsx'),
      source('app/image-generation/image-generation-progress.tsx'),
      source('app/image-generation/use-image-generation-run.ts'),
      source('app/globals.css'),
    ]);

    assert.match(route, /runId: z\.string\(\)\.uuid\(\)\.optional\(\)/u);
    assert.match(route, /runId: input\.runId/u);
    assert.match(statusRoute, /export async function GET/u);
    assert.match(statusRoute, /readStandaloneImageProgress/u);
    assert.match(statusRoute, /adminOutputRoot/u);
    assert.match(statusRoute, /'Cache-Control': 'no-store'/u);
    assert.match(runState, /crypto\.randomUUID\(\)/u);
    assert.match(runState, /xhs:image-generation-active-run:v1/u);
    assert.match(runState, /PROGRESS_MISS_LIMIT = 10/u);
    assert.match(runState, /useRef\(0\)/u);
    assert.match(runState, /setInterval/u);
    assert.match(runState, /`\/api\/image-generations\/\$\{[^}]+\}`/u);
    assert.match(runState, /cache: 'no-store'/u);
    assert.match(workbench, /<ImageGenerationProgress progress=\{progress\}/u);
    assert.match(progressView, /<progress/u);
    assert.match(progressView, /当前阶段/u);
    assert.match(progressView, /已用时间/u);
    assert.match(progressView, /预计剩余/u);
    assert.match(progressView, /完成图片/u);
    assert.match(progressView, /aria-live="polite"/u);
    assert.match(styles, /\.standalone-image-progress/u);
    assert.match(styles, /\.standalone-image-progress-bar/u);
  });

  it('serves only manifest-owned PNG files from the isolated run directory', async () => {
    const imageRoute = await source('app/api/image-generations/[runId]/images/[file]/route.ts');

    assert.match(imageRoute, /readStandaloneImageFile/u);
    assert.match(imageRoute, /adminOutputRoot/u);
    assert.match(imageRoute, /Content-Type': 'image\/png'/u);
    assert.match(imageRoute, /X-Content-Type-Options': 'nosniff'/u);
  });
});
