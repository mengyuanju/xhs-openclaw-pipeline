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

  it('exposes a Live-only API contract and safe error codes', async () => {
    const [route, runtime] = await Promise.all([
      source('app/api/image-generations/route.ts'),
      source('app/api/image-generations/_runtime.ts'),
    ]);
    const contract = `${route}\n${runtime}`;

    assert.doesNotMatch(route, /MOCK/u);
    assert.match(route, /mode: z\.literal\('LIVE'\)/u);
    assert.match(route, /validationCode: 'VALIDATION_ERROR'/u);
    assert.match(route, /LIVE_IMAGE_COST_ACCEPTED/u);
    assert.match(contract, /IMAGE_GENERATION_IN_PROGRESS/u);
    assert.match(route, /LIVE_CONFIRMATION_REQUIRED/u);
    assert.match(contract, /IMAGE_ALIGNMENT_FAILED/u);
    assert.match(contract, /ALIGNMENT_RESPONSE_INVALID/u);
    assert.match(contract, /ALIGNMENT_SERVICE_FAILED/u);
    assert.match(contract, /IMAGE_GENERATION_FAILED/u);
    assert.match(route, /generateStandaloneImages/u);
    assert.match(runtime, /createOpenClawClient/u);
    assert.match(runtime, /withImageGenerationLock/u);
    assert.match(runtime, /imageGenerationRuntime\(\)/u);
    assert.doesNotMatch(runtime, /if \(!live\)/u);
    assert.match(route, /imageGenerationRuntime\(\)/u);
  });

  it('requires explicit cost confirmation and a fresh run ID before resuming', async () => {
    const [attemptRoute, workbench, progressView, runState] = await Promise.all([
      source('app/api/image-generations/[runId]/attempts/route.ts'),
      source('app/image-generation/image-generation-workbench.tsx'),
      source('app/image-generation/image-generation-progress.tsx'),
      source('app/image-generation/use-image-generation-run.ts'),
    ]);

    assert.match(attemptRoute, /export async function POST/u);
    assert.match(attemptRoute, /z\.literal\('LIVE_IMAGE_COST_ACCEPTED'\)/u);
    assert.match(attemptRoute, /retryStandaloneImageRun/u);
    assert.match(attemptRoute, /sourceRunId: runId/u);
    assert.match(attemptRoute, /runId: input\.runId/u);
    assert.match(attemptRoute, /withImageGenerationLock/u);
    assert.match(runState, /retryRun/u);
    assert.match(runState, /\/attempts/u);
    assert.match(runState, /confirmation: 'LIVE_IMAGE_COST_ACCEPTED'/u);
    assert.match(progressView, /已生成/u);
    assert.match(progressView, /已验收/u);
    assert.match(progressView, /重新验收并继续/u);
    assert.match(workbench, /复用已生成图片/u);
    assert.match(workbench, /retryRun/u);
  });

  it('renders labeled inputs, mandatory cost confirmation, loading, errors and image previews', async () => {
    const [workbench, resultView, runState, styles] = await Promise.all([
      source('app/image-generation/image-generation-workbench.tsx'),
      source('app/image-generation/image-generation-result.tsx'),
      source('app/image-generation/use-image-generation-run.ts'),
      source('app/globals.css'),
    ]);

    assert.match(workbench, /^'use client';/u);
    assert.match(workbench, /htmlFor="image-query"/u);
    assert.match(workbench, /htmlFor="image-title"/u);
    assert.match(workbench, /htmlFor="image-body"/u);
    assert.match(workbench, /htmlFor="image-tags"/u);
    assert.match(workbench, /htmlFor="image-plan"/u);
    assert.doesNotMatch(workbench, /Mock|MOCK|image-mode/u);
    assert.match(workbench, /mode: 'LIVE'/u);
    assert.match(workbench, /LIVE_IMAGE_COST_ACCEPTED/u);
    assert.match(workbench, /确认调用真实图片模型/u);
    assert.match(workbench, /正在生成图片/u);
    assert.match(workbench, /role=\{messageIsError \? 'alert' : 'status'\}/u);
    assert.match(workbench, /<ImageGenerationResultView result=\{result\}/u);
    assert.match(runState, /visualPlan/u);
    assert.match(runState, /layout/u);
    assert.match(runState, /dimensions/u);
    assert.match(resultView, /成品预览/u);
    assert.match(resultView, /视觉布局/u);
    assert.match(resultView, /图片质检意见/u);
    assert.match(resultView, /result\.images\.map/u);
    assert.match(resultView, /image\.layout/u);
    assert.match(resultView, /result\.qc\.dimensions\.map/u);
    assert.match(resultView, /result\.qc\.issues/u);
    assert.match(resultView, /<img/u);
    assert.match(styles, /\.standalone-image-workspace/u);
    assert.match(styles, /\.standalone-image-page-list/u);
    assert.match(styles, /\.standalone-image-layout/u);
    assert.match(styles, /\.standalone-image-quality/u);
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
    assert.match(route, /const runId = input\.runId \?\? randomUUID\(\)/u);
    assert.match(route, /runId,\s+signal,/u);
    assert.match(statusRoute, /export async function GET/u);
    assert.match(statusRoute, /readStandaloneImageProgress/u);
    assert.match(statusRoute, /progress\.mode !== 'LIVE'/u);
    assert.match(statusRoute, /adminOutputRoot/u);
    assert.match(statusRoute, /'Cache-Control': 'no-store'/u);
    assert.match(runState, /createRunId\(\)/u);
    assert.match(runState, /xhs:image-generation-active-run:v1/u);
    assert.match(runState, /PROGRESS_MISS_LIMIT = 10/u);
    assert.match(runState, /useRef\(0\)/u);
    assert.match(runState, /setInterval/u);
    assert.match(runState, /`\/api\/image-generations\/\$\{[^}]+\}`/u);
    assert.match(runState, /cache: 'no-store'/u);
    assert.match(workbench, /<ImageGenerationProgress\s+progress=\{progress\}/u);
    assert.match(progressView, /<progress/u);
    assert.match(progressView, /当前阶段/u);
    assert.match(progressView, /已用时间/u);
    assert.match(progressView, /预计剩余/u);
    assert.match(progressView, /已生成/u);
    assert.match(progressView, /已验收/u);
    assert.match(progressView, /aria-live="polite"/u);
    assert.match(styles, /\.standalone-image-progress/u);
    assert.match(styles, /\.standalone-image-progress-bar/u);
  });

  it('lets the operator cancel active and restart-stale image runs', async () => {
    const [statusRoute, runtime, workbench, progressView, history, runState] = await Promise.all([
      source('app/api/image-generations/[runId]/route.ts'),
      source('app/api/image-generations/_runtime.ts'),
      source('app/image-generation/image-generation-workbench.tsx'),
      source('app/image-generation/image-generation-progress.tsx'),
      source('app/image-generation/image-generation-history.tsx'),
      source('app/image-generation/use-image-generation-run.ts'),
    ]);

    assert.match(statusRoute, /export async function DELETE/u);
    assert.match(statusRoute, /cancelStandaloneImageRun/u);
    assert.match(statusRoute, /cancelActiveImageGeneration/u);
    assert.match(runtime, /new AbortController\(\)/u);
    assert.match(runtime, /globalThis/u);
    assert.match(runtime, /controller\.abort/u);
    assert.match(runState, /cancelRun/u);
    assert.match(runState, /method: 'DELETE'/u);
    assert.match(workbench, /取消图片生成/u);
    assert.match(progressView, /取消生成/u);
    assert.match(progressView, /progress\.status === 'RUNNING'/u);
    assert.match(history, /已取消/u);
  });

  it('serves only manifest-owned PNG files from the isolated run directory', async () => {
    const imageRoute = await source('app/api/image-generations/[runId]/images/[file]/route.ts');

    assert.match(imageRoute, /readStandaloneImageFile/u);
    assert.match(imageRoute, /adminOutputRoot/u);
    assert.match(imageRoute, /Content-Type': 'image\/png'/u);
    assert.match(imageRoute, /X-Content-Type-Options': 'nosniff'/u);
  });

  it('lists saved runs and lets the operator reopen a historical result', async () => {
    const [route, workbench, history, historyState, runState, styles] = await Promise.all([
      source('app/api/image-generations/route.ts'),
      source('app/image-generation/image-generation-workbench.tsx'),
      source('app/image-generation/image-generation-history.tsx'),
      source('app/image-generation/use-image-generation-history.ts'),
      source('app/image-generation/use-image-generation-run.ts'),
      source('app/globals.css'),
    ]);

    assert.match(route, /export async function GET/u);
    assert.match(route, /listStandaloneImageRuns/u);
    assert.match(historyState, /\/api\/image-generations\?limit=50/u);
    assert.match(historyState, /hasRunningRuns/u);
    assert.match(history, /图片生成历史/u);
    assert.match(history, /已完成/u);
    assert.match(history, /生成失败/u);
    assert.match(history, /生成中/u);
    assert.match(history, /aria-pressed/u);
    assert.match(runState, /openRun/u);
    assert.match(workbench, /<ImageGenerationHistory/u);
    assert.match(workbench, /openRun/u);
    assert.match(workbench, /URLSearchParams\(window\.location\.search\)/u);
    assert.match(styles, /\.standalone-image-workspace-grid/u);
    assert.match(styles, /\.standalone-image-history/u);
  });
});
