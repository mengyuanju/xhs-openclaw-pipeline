import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import sharp from 'sharp';

import { buildDeliveryImageTaskPrompt, createMockPost, processNext } from '../src/pipeline.mjs';
import { buildPostPrompt } from '../src/post-contract.mjs';
import { createQueue } from '../src/queue.mjs';
import { createMockVisualPlan } from '../src/visual-plan.mjs';

const directories = [];
const queues = [];

it('asks the image model to render the full page from the structured layout contract', () => {
  const post = createMockPost();
  const visualPage = {
    layoutSchemaVersion: 1,
    layoutTemplate: 'CHECKLIST_RIGHT',
    sourceEvidence: ['先核对项目备案，再判断就业前景。'],
    visualSubject: '招生材料与核验场景',
    layoutDirection: '下半区为5张检查卡。',
    allowedVisibleText: {
      headline: '报考前检查清单',
      subtitle: '逐项核对',
      bullets: ['一', '二', '三', '四', '五'],
      labels: [],
    },
    mustShow: [],
    mustAvoid: [],
  };

  const prompt = buildDeliveryImageTaskPrompt({
    post,
    plan: { kind: 'checklist', prompt: '清单页' },
    visualPage,
    imageIndex: 1,
    imageCount: 3,
  });

  assert.match(prompt, /同一次生成中完成主体、标题、要点、标签、卡片和装饰/u);
  assert.match(prompt, /严格生成且仅生成 5 个清单项/u);
  assert.doesNotMatch(prompt, /程序会严格绘制/u);
  assert.match(prompt, /"layoutTemplate": "CHECKLIST_RIGHT"/u);
  assert.match(prompt, /主体区域：左侧/u);
  assert.match(prompt, /文字排版区域：右侧/u);
  assert.match(prompt, /3:4.*1086×1448/u);
  assert.match(prompt, /禁止白色、深色和暗色背景/u);
  assert.match(prompt, /字体不超过 3 种/u);
  assert.match(prompt, /所有汉字和字母.*水平排列/u);
  assert.match(prompt, /画面主体.*中心/u);
  assert.match(prompt, /优先采用真实风格/u);
  assert.match(prompt, /allowedVisibleText.*精简文字/u);
  assert.match(prompt, /不得照搬正文中的其他长段落/u);

  const promptWithoutDisclosure = buildDeliveryImageTaskPrompt({
    post,
    plan: { kind: 'checklist', prompt: '清单页' },
    visualPage,
    imageIndex: 1,
    imageCount: 3,
    complianceDisclosure: '',
  });
  assert.doesNotMatch(promptWithoutDisclosure, /AI生成/u);

  const portraitPrompt = buildDeliveryImageTaskPrompt({
    post,
    plan: { kind: 'detail', prompt: '人物操作示范页' },
    visualPage: { ...visualPage, visualSubject: '居中的人物操作示范' },
    imageIndex: 2,
    imageCount: 3,
    complianceDisclosure: '',
  });
  assert.match(portraitPrompt, /右下角.*“AI生成”/u);

  const detailPrompt = buildDeliveryImageTaskPrompt({
    post,
    plan: { kind: 'detail', prompt: '详情页' },
    visualPage: { ...visualPage, layoutDirection: '左右分栏。' },
    imageIndex: 2,
    imageCount: 3,
  });
  assert.match(detailPrompt, /避免悬浮黑框、后贴字幕和空白占位模板/u);

  const comparisonPrompt = buildDeliveryImageTaskPrompt({
    post,
    plan: { kind: 'comparison', prompt: '对比页' },
    visualPage: { ...visualPage, layoutTemplate: 'COMPARISON_TWO_COLUMN' },
    imageIndex: 2,
    imageCount: 3,
  });
  assert.match(comparisonPrompt, /每条 allowedVisibleText 只能显示一次/u);
  assert.match(comparisonPrompt, /不得在栏内、页脚结论或装饰标签中重复同一句/u);
});

function passingAlignment(prompt) {
  const contract = JSON.parse(prompt.match(
    /<untrusted_alignment_contract>\n([\s\S]+?)\n<\/untrusted_alignment_contract>/u,
  )[1]);
  const allowed = contract.page.allowedVisibleText;
  return {
    schemaVersion: 1,
    subjectMatched: true,
    sceneMatched: true,
    headlineMatched: true,
    bulletCoverage: 1,
    styleMatched: true,
    layoutMatched: true,
    contradictions: [],
    extraClaims: [],
    textErrors: [],
    recognizedText: {
      headline: allowed.headline,
      subtitle: allowed.subtitle,
      bullets: allowed.bullets,
      otherText: allowed.labels ?? [],
    },
    unreadableText: [],
    hasTraditionalChinese: false,
    ocrConfidence: 0.98,
    failureClass: 'PASS',
    repairInstruction: '',
  };
}

const QUALITY_DIMENSIONS = [
  'queryRelevance',
  'contentOriginality',
  'imageBaseQuality',
  'imageTextQuality',
  'imageConsistency',
  'noteTone',
  'platformAdaptation',
  'informationValue',
  'imageAesthetics',
  'imageDiversity',
];

function qualityAssessment(score = 3) {
  return {
    schemaVersion: 1,
    dimensions: Object.fromEntries(QUALITY_DIMENSIONS.map((name) => [name, {
      score,
      evidence: [`终审证据 ${name}=${score}`],
      applicable: true,
    }])),
    issueLabels: [],
    typeAdjustments: [],
  };
}

function stageReviewOutput(decision = 'PASS', message = '可以继续。') {
  return {
    schemaVersion: 1,
    decision,
    summary: message,
    issues: decision === 'PASS' ? [] : [{
      code: 'STAGE_BLOCKED',
      severity: 'BLOCKING',
      message,
    }],
  };
}

function passingVisionOutput(prompt) {
  return prompt.includes('独立于生成模型的图文交付终审员')
    ? qualityAssessment(3)
    : passingAlignment(prompt);
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'xhs-pipeline-'));
  directories.push(directory);
  const queue = createQueue(join(directory, 'queue.sqlite'));
  queues.push(queue);
  return { directory, queue };
}

afterEach(async () => {
  while (queues.length > 0) queues.pop().close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('content pipeline', () => {
  it('moves one mock task from pending to a complete local delivery', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({
      query: '租房卧室的桌面总是乱，怎么做低成本整理？',
      input: { platform: 'xiaohongshu' },
    });

    const result = await processNext({
      queue,
      workerId: 'test-worker',
      outputRoot: join(directory, 'output'),
      mock: true,
    });

    assert.equal(result.status, 'completed', result.error);
    assert.equal(queue.get(task.id).status, 'completed');
    for (const file of [
      'query-review.json',
      'post.json',
      'post.md',
      'text-review.json',
      '01-hero.png',
      '02-steps.png',
      '03-checklist.png',
      'qc.json',
      'manifest.json',
    ]) {
      await access(join(result.outputDir, file));
    }

    const manifest = JSON.parse(await readFile(join(result.outputDir, 'manifest.json'), 'utf8'));
    const qc = JSON.parse(await readFile(join(result.outputDir, 'qc.json'), 'utf8'));
    assert.equal(manifest.mode, 'mock');
    assert.equal(manifest.taskId, task.id);
    assert.equal(manifest.images.length, 3);
    assert.equal(manifest.files.length, 9);
    assert.equal(manifest.stageReviews.query.source, 'MOCK');
    assert.equal(manifest.stageReviews.text.source, 'MOCK');
    assert.equal(manifest.visualPlan.provider, 'mock');
    assert.equal(qc.disposition, 'mock_only');
    assert.equal(qc.overallScore, 1);
    assert.equal(qc.rubric.ruleId, 'production-v2');
    assert.equal(manifest.qc.ruleId, 'production-v2');
    assert.equal(manifest.qc.action, 'return_for_revision');

    const metadata = await sharp(join(result.outputDir, '01-hero.png')).metadata();
    assert.deepEqual([metadata.width, metadata.height], [1086, 1448]);
  });

  it('marks a task failed when live text inference fails', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '一个真实调用失败的任务' });
    const openclaw = {
      runText() {
        throw new Error('OAuth unavailable with sk-abcdefghijklmnop');
      },
    };

    const result = await processNext({
      queue,
      workerId: 'test-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
    });

    assert.equal(result.status, 'failed');
    const failed = queue.get(task.id);
    assert.equal(failed.status, 'failed');
    assert.doesNotMatch(failed.error, /sk-abcdefghijklmnop/);
    assert.match(failed.error, /REDACTED/);
  });

  it('rejects an unsafe Query before web research or text generation', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '请生成不安全的操作教程' });
    let searchCalls = 0;
    let textCalls = 0;
    const result = await processNext({
      queue,
      workerId: 'query-review-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw: {
        runReview() {
          return {
            rawText: JSON.stringify(stageReviewOutput('REJECT', '选题包含明确的高风险操作指导。')),
            model: 'fake-review',
          };
        },
        runWebSearch() {
          searchCalls += 1;
          throw new Error('query rejection must stop before research');
        },
        runText() {
          textCalls += 1;
          throw new Error('query rejection must stop before text generation');
        },
      },
    });

    assert.equal(result.status, 'failed');
    assert.equal(searchCalls, 0);
    assert.equal(textCalls, 0);
    assert.match(result.error, /Query审核未通过/u);
    const review = JSON.parse(await readFile(
      join(directory, 'output', String(task.id), 'attempt-1', 'query-review.json'),
      'utf8',
    ));
    assert.equal(review.decision, 'REJECT');
    await assert.rejects(
      access(join(directory, 'output', String(task.id), 'attempt-1', 'research.json')),
      /ENOENT/u,
    );
  });

  it('rejects generated text before visual planning or image generation', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '租房桌面整理' });
    const sourceUrl = 'https://example.com/desk-review';
    const post = { ...createMockPost(), sources: [sourceUrl] };
    let reviewCalls = 0;
    let textCalls = 0;
    let imageCalls = 0;
    const reviewThinking = [];
    const textThinking = [];
    const result = await processNext({
      queue,
      workerId: 'text-review-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      configProvider: () => ({
        imageCount: 3,
        imageCountMode: 'fixed',
        productionSettings: { modelApi: { copyGenerationThinking: 'xhigh' } },
      }),
      openclaw: {
        runReview({ thinking }) {
          reviewCalls += 1;
          reviewThinking.push(thinking);
          const output = reviewCalls === 1
            ? stageReviewOutput('PASS')
            : stageReviewOutput('REJECT', '正文的关键结论与 Query 无关。');
          return { rawText: JSON.stringify(output), model: 'fake-review' };
        },
        runWebSearch({ query }) {
          return {
            provider: 'codex',
            result: { content: '桌面整理资料', searches: [{ query }], results: [{
              title: '整理资料',
              url: sourceUrl,
              snippet: '整理方法摘要',
            }] },
          };
        },
        runText({ thinking }) {
          textCalls += 1;
          textThinking.push(thinking);
          if (textCalls === 1) return { rawText: JSON.stringify(post), model: 'fake-text' };
          throw new Error('text rejection must stop before visual planning');
        },
        runImage() {
          imageCalls += 1;
          throw new Error('text rejection must stop before image generation');
        },
      },
    });

    assert.equal(result.status, 'failed');
    assert.equal(reviewCalls, 2);
    assert.equal(textCalls, 1);
    assert.deepEqual(reviewThinking, [undefined, 'xhigh']);
    assert.deepEqual(textThinking, ['xhigh']);
    assert.equal(imageCalls, 0);
    assert.match(result.error, /文本审核未通过/u);
    const attemptDir = join(directory, 'output', String(task.id), 'attempt-1');
    assert.equal(JSON.parse(await readFile(join(attemptDir, 'text-review.json'), 'utf8')).decision, 'REJECT');
    await assert.rejects(access(join(attemptDir, 'visual-plan.json')), /ENOENT/u);
  });

  it('schedules a bounded task-level retry for a transient live failure', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '瞬时传输错误自动恢复任务' });

    const result = await processNext({
      queue,
      workerId: 'recovery-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      recoveryEnabled: true,
      openclaw: {
        runText() {
          throw new Error('fetch failed: UND_ERR_SOCKET');
        },
      },
    });

    assert.equal(result.status, 'retry_scheduled');
    assert.equal(result.recovery.failureClass, 'TRANSIENT');
    assert.equal(result.recovery.delayMs, 15_000);
    const scheduled = queue.get(task.id);
    assert.equal(scheduled.status, 'pending');
    assert.equal(scheduled.recoveryAttempts, 1);
    assert.equal(scheduled.recoveryTotalAttempts, 1);
    assert.equal(scheduled.manualRequired, false);
    assert.ok(Date.parse(scheduled.nextAttemptAt) > Date.now());
  });

  it('opens the auth circuit and stops claiming tasks after an authentication failure', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '认证失败任务' });
    queue.enqueue({ query: '不得继续领取的后续任务' });
    const options = {
      queue,
      workerId: 'auth-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      recoveryEnabled: true,
      openclaw: {
        runText() {
          throw new Error('401 token_invalidated');
        },
      },
    };

    const failed = await processNext(options);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.recovery.failureClass, 'AUTH');
    assert.equal(failed.recovery.haltWorker, true);
    assert.equal(queue.get(task.id).manualRequired, true);
    assert.equal(queue.getCircuit('openclaw-auth').status, 'OPEN');

    const blocked = await processNext(options);
    assert.deepEqual(blocked, {
      status: 'blocked',
      reason: 'authentication_required',
      haltWorker: true,
    });
    assert.equal(queue.get(2).attempts, 0);
  });

  it('retries malformed live post output before starting visual planning', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '正文第一次格式错误的任务' });
    const sourceUrl = 'https://www.gov.cn/zhengce/research-source';
    const post = { ...createMockPost(), sources: [sourceUrl] };
    const rawImages = await Promise.all(['#d7c7b0', '#c7d7b0', '#b0c7d7'].map((background) => sharp({
      create: { width: 1024, height: 1536, channels: 3, background },
    }).png().toBuffer()));
    const textPrompts = [];
    let researchCalls = 0;
    let imageIndex = 0;
    const openclaw = {
      runWebSearch({ query, provider }) {
        researchCalls += 1;
        assert.equal(query, task.query);
        assert.equal(provider, 'codex');
        return {
          provider: 'codex',
          result: {
            content: `已核验来源：${sourceUrl}`,
            searches: [{ query }],
          },
        };
      },
      runText({ prompt }) {
        textPrompts.push(prompt);
        if (textPrompts.length === 1) return { rawText: 'temporary malformed response', model: 'fake-text' };
        if (textPrompts.length === 2) return { rawText: JSON.stringify(post), model: 'fake-text' };
        return {
          rawText: JSON.stringify(createMockVisualPlan(post, { imageCount: 3 })),
          model: 'fake-text',
        };
      },
      runImage({ outputPath }) {
        writeFileSync(outputPath, rawImages[imageIndex]);
        imageIndex += 1;
        return { outputPath, model: 'fake-image' };
      },
      runImageEdit({ outputPath }) {
        writeFileSync(outputPath, rawImages[imageIndex]);
        imageIndex += 1;
        return { outputPath, model: 'fake-image' };
      },
      runVision({ prompt }) {
        const output = prompt.includes('独立于生成模型的图文交付终审员')
          ? qualityAssessment(3)
          : passingAlignment(prompt);
        return { rawText: JSON.stringify(output), model: 'fake-vision' };
      },
    };

    const result = await processNext({
      queue,
      workerId: 'test-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
      configProvider: () => ({ imageCount: 3, imageCountMode: 'fixed' }),
    });

    assert.equal(result.status, 'completed', result.error);
    assert.equal(researchCalls, 1);
    assert.equal(textPrompts.length, 3);
    assert.match(textPrompts[1], /结构化文案定点修复器/u);
    assert.match(textPrompts[1], /模型输出不是合法 JSON/u);
    assert.match(textPrompts[0], /webResearch/u);
    assert.match(textPrompts[0], /https:\/\/www\.gov\.cn\/zhengce\/research-source/u);
    const research = JSON.parse(await readFile(join(result.outputDir, 'research.json'), 'utf8'));
    assert.equal(research.status, 'COMPLETED');
    assert.equal(research.sources[0].url, sourceUrl);
    const manifest = JSON.parse(await readFile(join(result.outputDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.research, {
      status: 'COMPLETED',
      provider: 'codex',
      sourceCount: 1,
      searchedAt: research.searchedAt,
    });
    assert.ok(manifest.files.some((file) => file.file === 'research.json'));
  });

  it('fails closed before text generation and saves the failed research snapshot', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '必须先核验来源的任务' });
    let searchCalls = 0;
    let textCalls = 0;
    let failedResearch = null;
    const result = await processNext({
      queue,
      workerId: 'research-failure-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw: {
        runWebSearch() {
          searchCalls += 1;
          throw new Error('search transport unavailable');
        },
        runText() {
          textCalls += 1;
          throw new Error('text generation must not start');
        },
      },
      async onFailed({ researchSnapshot }) {
        failedResearch = researchSnapshot;
      },
    });

    assert.equal(result.status, 'failed');
    assert.equal(searchCalls, 4);
    assert.equal(textCalls, 0);
    assert.match(result.error, /联网研究失败/u);
    const research = JSON.parse(await readFile(
      join(directory, 'output', String(task.id), 'attempt-1', 'research.json'),
      'utf8',
    ));
    assert.equal(research.status, 'FAILED');
    assert.deepEqual(failedResearch, research);
  });

  it('returns a bounded failure when the task lease is lost during processing', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '处理中租约被其他 Worker 接管的任务' });
    queue.renewLease = () => {
      throw new Error('task is not processing or lease owner does not match');
    };
    queue.fail = () => {
      throw new Error('task is not processing or lease owner does not match');
    };

    const result = await processNext({
      queue,
      workerId: 'stale-worker',
      outputRoot: join(directory, 'output'),
      mock: true,
    });

    assert.deepEqual(result, {
      status: 'failed',
      taskId: task.id,
      error: 'task lease was lost before the failure could be recorded',
    });
  });

  it('renews the task lease while an asynchronous stage is still pending', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '长耗时阶段仍需保持租约的任务' });
    const renewals = [];
    const originalRenewLease = queue.renewLease.bind(queue);
    queue.renewLease = (id, options) => {
      renewals.push({ id, workerId: options.workerId });
      return originalRenewLease(id, options);
    };
    let releaseConfig;
    const configReady = new Promise((resolve) => {
      releaseConfig = resolve;
    });

    const processing = processNext({
      queue,
      workerId: 'heartbeat-worker',
      outputRoot: join(directory, 'output'),
      mock: true,
      leaseMs: 1_000,
      async configProvider() {
        await configReady;
        return null;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.ok(renewals.length >= 2, `expected periodic lease renewals, received ${renewals.length}`);
    assert.ok(renewals.every((renewal) => renewal.id === task.id
      && renewal.workerId === 'heartbeat-worker'));
    releaseConfig();
    const result = await processing;
    assert.equal(result.status, 'completed', result.error);
  });

  it('retries one invalid visual plan before starting image generation', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '视觉规划第一次格式错误的任务' });
    const renewals = [];
    const originalRenewLease = queue.renewLease.bind(queue);
    queue.renewLease = (id, options) => {
      renewals.push({ id, workerId: options.workerId });
      return originalRenewLease(id, options);
    };
    const post = createMockPost();
    const rawImages = await Promise.all(['#d7c7b0', '#c7d7b0', '#b0c7d7'].map((background) => sharp({
      create: { width: 1024, height: 1536, channels: 3, background },
    }).png().toBuffer()));
    const textPrompts = [];
    let imageCalls = 0;
    const openclaw = {
      runText({ prompt }) {
        textPrompts.push(prompt);
        const plan = createMockVisualPlan(post, { imageCount: 3 });
        if (textPrompts.length === 1) plan.pages[0].sourceEvidence = [];
        return { rawText: JSON.stringify(plan), model: 'fake-text' };
      },
      runImage({ outputPath }) {
        writeFileSync(outputPath, rawImages[imageCalls]);
        imageCalls += 1;
        return { outputPath, model: 'fake-image' };
      },
      runImageEdit({ outputPath }) {
        writeFileSync(outputPath, rawImages[imageCalls]);
        imageCalls += 1;
        return { outputPath, model: 'fake-image' };
      },
      runVision({ prompt }) {
        return { rawText: JSON.stringify(passingVisionOutput(prompt)), model: 'fake-vision' };
      },
    };

    const result = await processNext({
      queue,
      workerId: 'test-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
      configProvider: () => ({ imageCount: 3, imageCountMode: 'fixed', postOverride: post }),
    });

    assert.equal(result.status, 'completed', result.error);
    assert.equal(queue.get(task.id).status, 'completed');
    assert.equal(textPrompts.length, 2);
    assert.match(textPrompts[1], /上一次视觉规划输出未通过结构校验/);
    assert.match(textPrompts[1], /pages\[0\]\.sourceEvidence/);
    assert.ok(renewals.length >= 8);
    assert.ok(renewals.every((renewal) => renewal.id === task.id
      && renewal.workerId === 'test-worker'));
  });

  it('falls back to a deterministic visual plan after three invalid model responses', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '视觉规划连续格式错误的任务' });
    const post = createMockPost();
    const rawImages = await Promise.all(['#d7c7b0', '#c7d7b0', '#b0c7d7'].map((background) => sharp({
      create: { width: 1024, height: 1536, channels: 3, background },
    }).png().toBuffer()));
    let textCalls = 0;
    let imageCalls = 0;
    const openclaw = {
      runText() {
        textCalls += 1;
        const plan = createMockVisualPlan(post, { imageCount: 3 });
        plan.pages[0].sourceEvidence = [];
        return { rawText: JSON.stringify(plan), model: 'fake-text' };
      },
      runImage({ outputPath }) {
        writeFileSync(outputPath, rawImages[imageCalls]);
        imageCalls += 1;
        return { outputPath, model: 'fake-image' };
      },
      runImageEdit({ outputPath }) {
        writeFileSync(outputPath, rawImages[imageCalls]);
        imageCalls += 1;
        return { outputPath, model: 'fake-image-edit' };
      },
      runVision({ prompt }) {
        return { rawText: JSON.stringify(passingVisionOutput(prompt)), model: 'fake-vision' };
      },
    };

    const result = await processNext({
      queue,
      workerId: 'test-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
      configProvider: () => ({ imageCount: 3, imageCountMode: 'fixed', postOverride: post }),
    });

    assert.equal(result.status, 'completed', result.error);
    assert.equal(textCalls, 3);
    assert.equal(imageCalls, 3);
    assert.equal(queue.get(task.id).status, 'completed');
    const manifest = JSON.parse(await readFile(join(result.outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.visualPlan.model, 'deterministic-fallback');
  });

  it('reuses text and visual-plan checkpoints after image failure and invalidates them when config changes', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '图片失败后继续生成的任务', input: { category: '收纳' } });
    const post = createMockPost();
    const rawImages = await Promise.all(['#d7c7b0', '#c7d7b0', '#b0c7d7'].map((background) => sharp({
      create: { width: 1024, height: 1536, channels: 3, background },
    }).png().toBuffer()));
    let textCalls = 0;
    let reviewCalls = 0;
    let researchCalls = 0;
    let imageCalls = 0;
    let deliveredImages = 0;
    let allowImages = false;
    let configRevision = 'A';
    const openclaw = {
      runReview() {
        reviewCalls += 1;
        return { rawText: JSON.stringify(stageReviewOutput('PASS')), model: 'fake-review' };
      },
      runWebSearch({ query }) {
        researchCalls += 1;
        return {
          provider: 'duckduckgo',
          result: {
            results: [{
              title: '恢复测试来源',
              url: 'https://example.gov.cn/resume-source',
              snippet: query,
            }],
          },
        };
      },
      runText({ prompt }) {
        textCalls += 1;
        return {
          rawText: JSON.stringify(
            prompt.includes('视觉规划步骤') ? createMockVisualPlan(post, { imageCount: 3 }) : post,
          ),
          model: 'fake-text',
        };
      },
      runImage({ outputPath }) {
        imageCalls += 1;
        if (!allowImages) throw new Error('temporary image outage');
        writeFileSync(outputPath, rawImages[deliveredImages]);
        deliveredImages += 1;
        return { outputPath, model: 'fake-image' };
      },
      runImageEdit({ outputPath }) {
        imageCalls += 1;
        if (!allowImages) throw new Error('temporary image outage');
        writeFileSync(outputPath, rawImages[deliveredImages]);
        deliveredImages += 1;
        return { outputPath, model: 'fake-image' };
      },
      runVision({ prompt }) {
        return { rawText: JSON.stringify(passingVisionOutput(prompt)), model: 'fake-vision' };
      },
    };
    const configProvider = () => ({
      imageCount: 3,
      imageCountMode: 'fixed',
      textPromptContent: `固定文案规则 ${configRevision}：{{query}}`,
      imagePromptContent: '固定图片规则：{{query}}',
    });

    const first = await processNext({
      queue,
      workerId: 'resume-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
      configProvider,
    });
    assert.equal(first.status, 'failed');
    assert.equal(researchCalls, 1);
    assert.equal(textCalls, 2);
    assert.equal(reviewCalls, 2);
    await access(join(directory, 'output', String(task.id), 'attempt-1', 'post.json'));
    await access(join(directory, 'output', String(task.id), 'attempt-1', 'visual-plan.json'));

    queue.retry(task.id);
    const second = await processNext({
      queue,
      workerId: 'resume-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
      configProvider,
    });
    assert.equal(second.status, 'failed');
    assert.equal(researchCalls, 1, 'unchanged config must reuse the research snapshot');
    assert.equal(textCalls, 2, 'unchanged config must reuse both completed text stages');
    assert.equal(reviewCalls, 2, 'unchanged config must reuse both completed stage reviews');

    queue.retry(task.id);
    configRevision = 'B';
    allowImages = true;
    const third = await processNext({
      queue,
      workerId: 'resume-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
      configProvider,
    });
    assert.equal(third.status, 'completed', third.error);
    assert.equal(researchCalls, 2, 'changed pinned config must create a new research snapshot');
    assert.equal(textCalls, 4, 'changed pinned config must invalidate both text checkpoints');
    assert.equal(reviewCalls, 4, 'changed pinned config must invalidate both stage reviews');
    assert.equal(queue.get(task.id).attempts, 3);
  });

  it('reuses only hash-verified pages that already passed alignment', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '只重做失败图片页面的任务' });
    const post = createMockPost();
    const rawImages = await Promise.all(['#d7c7b0', '#c7d7b0', '#b0c7d7'].map((background) => sharp({
      create: { width: 1024, height: 1536, channels: 3, background },
    }).png().toBuffer()));
    let textCalls = 0;
    let imageCalls = 0;
    let failSecondPage = true;
    const openclaw = {
      runText({ prompt }) {
        textCalls += 1;
        return {
          rawText: JSON.stringify(
            prompt.includes('视觉规划步骤') ? createMockVisualPlan(post, { imageCount: 3 }) : post,
          ),
          model: 'fake-text',
        };
      },
      runImage({ outputPath }) {
        imageCalls += 1;
        writeFileSync(outputPath, rawImages[0]);
        return { outputPath, model: 'fake-image' };
      },
      runImageEdit({ outputPath }) {
        imageCalls += 1;
        const pageIndex = Number(outputPath.match(/\.raw-(\d+)-/u)?.[1]);
        writeFileSync(outputPath, rawImages[pageIndex - 1]);
        return { outputPath, model: 'fake-image' };
      },
      runVision({ prompt }) {
        if (prompt.includes('独立于生成模型的图文交付终审员')) {
          return { rawText: JSON.stringify(qualityAssessment(3)), model: 'fake-vision' };
        }
        const contract = JSON.parse(prompt.match(
          /<untrusted_alignment_contract>\n([\s\S]+?)\n<\/untrusted_alignment_contract>/u,
        )[1]);
        const result = passingAlignment(prompt);
        if (failSecondPage && contract.page.index === 2) {
          result.sceneMatched = false;
          result.failureClass = 'SEMANTIC';
          result.repairInstruction = '重新生成与第二页证据一致的场景';
        }
        return { rawText: JSON.stringify(result), model: 'fake-vision' };
      },
    };

    const first = await processNext({
      queue,
      workerId: 'page-resume-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
      configProvider: () => ({ imageCount: 3, imageCountMode: 'fixed', postOverride: post }),
    });
    assert.equal(first.status, 'failed');
    assert.equal(textCalls, 1);
    assert.equal(imageCalls, 10, 'page repair stops after the first whole-set repair does not improve quality');

    queue.retry(task.id);
    failSecondPage = false;
    const second = await processNext({
      queue,
      workerId: 'page-resume-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
      configProvider: () => ({ imageCount: 3, imageCountMode: 'fixed', postOverride: post }),
    });

    assert.equal(second.status, 'completed', second.error);
    assert.equal(textCalls, 1, 'post override and visual plan are reused');
    assert.equal(imageCalls, 11, 'the retry reuses passed pages and regenerates only the failed second page');
    const manifest = JSON.parse(await readFile(join(second.outputDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.images.map((image) => image.reusedFromCheckpoint === true), [true, false, true]);
  });

  it('discards a malformed visual-plan checkpoint and regenerates that stage', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '损坏检查点恢复任务' });
    const post = createMockPost();
    const rawImages = await Promise.all(['#d7c7b0', '#c7d7b0', '#b0c7d7'].map((background) => sharp({
      create: { width: 1024, height: 1536, channels: 3, background },
    }).png().toBuffer()));
    let visualPlanCalls = 0;
    let allowImages = false;
    let deliveredImages = 0;
    const openclaw = {
      runText() {
        visualPlanCalls += 1;
        return { rawText: JSON.stringify(createMockVisualPlan(post)), model: 'fake-text' };
      },
      runImage({ outputPath }) {
        if (!allowImages) throw new Error('temporary image outage');
        writeFileSync(outputPath, rawImages[deliveredImages]);
        deliveredImages += 1;
        return { outputPath, model: 'fake-image' };
      },
      runImageEdit({ outputPath }) {
        writeFileSync(outputPath, rawImages[deliveredImages]);
        deliveredImages += 1;
        return { outputPath, model: 'fake-image' };
      },
      runVision({ prompt }) {
        return { rawText: JSON.stringify(passingVisionOutput(prompt)), model: 'fake-vision' };
      },
    };
    const options = {
      queue,
      workerId: 'corrupt-checkpoint-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
      configProvider: () => ({ imageCount: 3, imageCountMode: 'fixed', postOverride: post }),
    };

    assert.equal((await processNext(options)).status, 'failed');
    assert.equal(visualPlanCalls, 1);
    const checkpointPath = join(directory, 'output', String(task.id), 'checkpoint.json');
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
    checkpoint.visualPlan.value.pages = [];
    writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);

    queue.retry(task.id);
    allowImages = true;
    const retried = await processNext(options);

    assert.equal(retried.status, 'completed', retried.error);
    assert.equal(visualPlanCalls, 2);
  });

  it('returns idle without writing files when the queue is empty', async () => {
    const { directory, queue } = await setup();

    const result = await processNext({
      queue,
      workerId: 'test-worker',
      outputRoot: join(directory, 'output'),
      mock: true,
    });

    assert.deepEqual(result, { status: 'idle' });
  });

  it('does not mark a live task completed when the quality gate blocks it', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '需要核验事实的桌面整理任务' });
    const post = createMockPost();
    post.unverifiedClaims = ['某个没有来源支持的量化结论'];
    const rawPng = await sharp({
      create: { width: 1024, height: 1536, channels: 3, background: '#d7c7b0' },
    }).png().toBuffer();
    const openclaw = {
      runText({ prompt }) {
        return {
          rawText: JSON.stringify(
            prompt.includes('视觉规划步骤') ? createMockVisualPlan(post, { imageCount: 3 }) : post,
          ),
          model: 'openai/gpt-5.6-sol',
        };
      },
      runImage({ outputPath }) {
        writeFileSync(outputPath, rawPng);
        return { outputPath, model: 'openai/gpt-image-2' };
      },
      runImageEdit({ outputPath }) {
        writeFileSync(outputPath, rawPng);
        return { outputPath, model: 'openai/gpt-image-2' };
      },
      runVision({ prompt }) {
        return { rawText: JSON.stringify(passingVisionOutput(prompt)), model: 'fake-vision' };
      },
    };

    const result = await processNext({
      queue,
      workerId: 'test-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
    });

    assert.equal(result.status, 'failed');
    assert.equal(queue.get(task.id).status, 'failed');
    assert.match(queue.get(task.id).error, /质量门禁未通过/);
    assert.match(queue.get(task.id).error, /参考资料-缺失：存在 1 条待核验事实/);
    const checkpoint = JSON.parse(await readFile(
      join(directory, 'output', String(task.id), 'checkpoint.json'),
      'utf8',
    ));
    assert.equal(checkpoint.post, null);
    assert.equal(checkpoint.visualPlan, null);
    assert.deepEqual(checkpoint.images, []);
  });

  it('requires the independent final review to award 3 before completing a live task', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '三分终审任务' });
    const post = createMockPost();
    const rawImages = await Promise.all(['#d7c7b0', '#c7d7b0', '#b0c7d7'].map((background) => sharp({
      create: { width: 1024, height: 1536, channels: 3, background },
    }).png().toBuffer()));
    let imageIndex = 0;
    const openclaw = {
      runText({ prompt }) {
        return {
          rawText: JSON.stringify(createMockVisualPlan(post, { imageCount: 3 })),
          model: 'fake-text',
        };
      },
      runImage({ outputPath }) {
        writeFileSync(outputPath, rawImages[imageIndex]);
        imageIndex += 1;
        return { outputPath, model: 'fake-image' };
      },
      runImageEdit({ outputPath }) {
        writeFileSync(outputPath, rawImages[imageIndex]);
        imageIndex += 1;
        return { outputPath, model: 'fake-image' };
      },
      runVision({ prompt }) {
        const output = prompt.includes('独立于生成模型的图文交付终审员')
          ? qualityAssessment(2)
          : passingAlignment(prompt);
        return { rawText: JSON.stringify(output), model: 'fake-vision' };
      },
    };

    const result = await processNext({
      queue,
      workerId: 'test-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
      configProvider: () => ({ imageCount: 3, imageCountMode: 'fixed', postOverride: post }),
    });

    assert.equal(result.status, 'failed');
    assert.match(queue.get(task.id).error, /质量门禁未通过/);
    const qc = JSON.parse(await readFile(
      join(directory, 'output', String(task.id), 'attempt-1', 'qc.json'),
      'utf8',
    ));
    assert.equal(qc.overallScore, 2);
    const checkpoint = JSON.parse(await readFile(
      join(directory, 'output', String(task.id), 'checkpoint.json'),
      'utf8',
    ));
    assert.equal(checkpoint.post, null);
    assert.equal(checkpoint.visualPlan, null);
    assert.deepEqual(checkpoint.images, []);
  });

  it('allows an explicit local threshold to complete a reviewable 2-point delivery', async () => {
    const previousThreshold = process.env.XHS_MIN_COMPLETION_SCORE;
    process.env.XHS_MIN_COMPLETION_SCORE = '2';
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '二分人工审核任务' });
    const post = createMockPost();
    const rawImages = await Promise.all(['#d7c7b0', '#c7d7b0', '#b0c7d7'].map((background) => sharp({
      create: { width: 1024, height: 1536, channels: 3, background },
    }).png().toBuffer()));
    let imageIndex = 0;
    const openclaw = {
      runText() {
        return { rawText: JSON.stringify(createMockVisualPlan(post)), model: 'fake-text' };
      },
      runImage({ outputPath }) {
        writeFileSync(outputPath, rawImages[imageIndex]);
        imageIndex += 1;
        return { outputPath, model: 'fake-image' };
      },
      runImageEdit({ outputPath }) {
        writeFileSync(outputPath, rawImages[imageIndex]);
        imageIndex += 1;
        return { outputPath, model: 'fake-image-edit' };
      },
      runVision({ prompt }) {
        const output = prompt.includes('独立于生成模型的图文交付终审员')
          ? qualityAssessment(2)
          : passingAlignment(prompt);
        return { rawText: JSON.stringify(output), model: 'fake-vision' };
      },
    };

    try {
      const result = await processNext({
        queue,
        workerId: 'reviewable-worker',
        outputRoot: join(directory, 'output'),
        mock: false,
        openclaw,
        configProvider: () => ({ imageCount: 3, imageCountMode: 'fixed', postOverride: post }),
      });

      assert.equal(result.status, 'completed', result.error);
      assert.equal(result.qc.overallScore, 2);
      assert.equal(result.qc.disposition, 'manual_review_required');
      assert.equal(queue.get(task.id).status, 'completed');
    } finally {
      if (previousThreshold === undefined) delete process.env.XHS_MIN_COMPLETION_SCORE;
      else process.env.XHS_MIN_COMPLETION_SCORE = previousThreshold;
    }
  });

  it('stops whole-set quality repair when the first repair does not improve the score', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '一分后自动修复的图文任务' });
    const post = createMockPost();
    const repairColors = [
      '#8f8f8f', '#8f9f8f', '#8f8f9f',
      '#b79f8f', '#9fb78f', '#8f9fb7',
      '#d7c7b0', '#c7d7b0', '#b0c7d7',
    ];
    const rawImages = await Promise.all(Array.from({ length: 9 }, (_, index) => sharp({
      create: {
        width: 1024,
        height: 1536,
        channels: 3,
        background: repairColors[index],
      },
    }).png().toBuffer()));
    let imageCall = 0;
    let qualityCall = 0;
    const repairPrompts = [];
    const generate = ({ prompt, outputPath }) => {
      if (prompt.includes('<untrusted_quality_repair>')) repairPrompts.push(prompt);
      writeFileSync(outputPath, rawImages[imageCall]);
      imageCall += 1;
      return { outputPath, model: 'fake-image' };
    };
    const openclaw = {
      runText() {
        return { rawText: JSON.stringify(createMockVisualPlan(post)), model: 'fake-text' };
      },
      runImage: generate,
      runImageEdit: generate,
      runVision({ prompt }) {
        if (!prompt.includes('独立于生成模型的图文交付终审员')) {
          return { rawText: JSON.stringify(passingAlignment(prompt)), model: 'fake-vision' };
        }
        qualityCall += 1;
        const assessment = qualityAssessment(qualityCall <= 2 ? 1 : 2);
        if (qualityCall <= 2) {
          for (const dimension of ['queryRelevance', 'informationValue', 'noteTone']) {
            assessment.dimensions[dimension].score = 3;
          }
          assessment.dimensions.imageAesthetics.evidence = ['主体太小，三页构图重复。'];
          assessment.issueLabels = [{ severity: 'major', label: '图片-模板化', evidence: '三页构图重复。' }];
        }
        return { rawText: JSON.stringify(assessment), model: 'fake-quality' };
      },
    };

    const result = await processNext({
      queue,
      workerId: 'test-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
      configProvider: () => ({
        imageCount: 3,
        imageCountMode: 'fixed',
        postOverride: post,
        productionSettings: {
          qualityRepairEnabled: true,
          qualityRepairTriggerScore: 1,
          qualityRepairTargetScore: 2,
          qualityRepairMaxAttempts: 2,
          aiDisclosureEnabled: true,
          aiDisclosureText: 'AI生成',
        },
      }),
    });

    assert.equal(result.status, 'failed');
    assert.match(queue.get(task.id).error, /质量门禁未通过/);
    assert.equal(imageCall, 6);
    assert.equal(qualityCall, 2);
    assert.equal(repairPrompts.length, 3);
    assert.match(repairPrompts[0], /主体太小/u);
    const qc = JSON.parse(await readFile(
      join(directory, 'output', String(task.id), 'attempt-1', 'qc.json'),
      'utf8',
    ));
    assert.equal(qc.overallScore, 1);
    assert.equal(qc.qualityRepair.initialScore, 1);
    assert.equal(qc.qualityRepair.finalScore, 1);
    assert.equal(qc.qualityRepair.attempts.length, 1);
    assert.equal(qc.qualityRepair.attempts[0].scoreAfter, 1);
    assert.match(qc.qualityRepair.attempts[0].reasons.join('\n'), /主体太小/u);
    assert.match(qc.qualityRepair.attempts[0].methods.join('\n'), /主体|构图/u);
    assert.ok(qc.qualityRepair.attempts[0].durationMs >= 0);
    const checkpoint = JSON.parse(await readFile(
      join(directory, 'output', String(task.id), 'checkpoint.json'),
      'utf8',
    ));
    assert.equal(checkpoint.post.value.title, post.title);
    assert.equal(checkpoint.visualPlan.value.pages.length, 3);
    assert.deepEqual(checkpoint.images, []);
  });

  it('records the independent quality model for a 3-point live candidate', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '三分通过任务' });
    const post = createMockPost();
    const rawImages = await Promise.all(['#d7c7b0', '#c7d7b0', '#b0c7d7'].map((background) => sharp({
      create: { width: 1024, height: 1536, channels: 3, background },
    }).png().toBuffer()));
    let imageIndex = 0;
    const openclaw = {
      runText() {
        return { rawText: JSON.stringify(createMockVisualPlan(post)), model: 'fake-text' };
      },
      runImage({ outputPath }) {
        writeFileSync(outputPath, rawImages[imageIndex]);
        imageIndex += 1;
        return { outputPath, model: 'fake-image' };
      },
      runImageEdit({ outputPath }) {
        writeFileSync(outputPath, rawImages[imageIndex]);
        imageIndex += 1;
        return { outputPath, model: 'fake-image' };
      },
      runVision({ prompt }) {
        return { rawText: JSON.stringify(passingVisionOutput(prompt)), model: 'fake-quality-vision' };
      },
    };

    const result = await processNext({
      queue,
      workerId: 'test-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
      configProvider: () => ({ imageCount: 3, imageCountMode: 'fixed', postOverride: post }),
    });

    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.qc.overallScore, 3);
    const manifest = JSON.parse(await readFile(join(result.outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.qc.assessmentModel, 'fake-quality-vision');
  });

  it('passes pinned text, image count and reference files to live OpenClaw calls', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({
      query: '有参考图的玄关整理',
      input: { category: '收纳', targetAudience: '租房用户' },
    });
    const referencePath = join(directory, 'reference.png');
    await sharp({
      create: { width: 600, height: 800, channels: 3, background: '#d7c7b0' },
    }).png().toFile(referencePath);
    const rawImages = await Promise.all(['#d7c7b0', '#c7d7b0', '#b0c7d7', '#d7b0c7'].map((background) => sharp({
      create: { width: 1024, height: 1536, channels: 3, background },
    }).png().toBuffer()));
    const textPrompts = [];
    const imagePrompts = [];
    const imageInputPaths = [];
    let completedPromptTrace = null;
    const openclaw = {
      runText({ prompt }) {
        textPrompts.push(prompt);
        const post = createMockPost(4);
        return {
          rawText: JSON.stringify(
            prompt.includes('视觉规划步骤') ? createMockVisualPlan(post, { imageCount: 4 }) : post,
          ),
          model: 'fake-text',
        };
      },
      runImageEdit({ prompt, inputPaths, outputPath }) {
        imagePrompts.push(prompt);
        imageInputPaths.push(inputPaths);
        writeFileSync(outputPath, rawImages[imagePrompts.length - 1]);
        return { outputPath, model: 'fake-image-edit' };
      },
      runVision({ prompt }) {
        return { rawText: JSON.stringify(passingVisionOutput(prompt)), model: 'fake-vision' };
      },
    };

    const result = await processNext({
      queue,
      workerId: 'pinned-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
      configProvider: () => ({
        imageCount: 4,
        imageCountMode: 'fixed',
        textPromptContent: '围绕 {{query}} 写给 {{targetAudience}}，分类 {{category}}。',
        imagePromptContent: '生成第 {{imageIndex}} 张，共 {{imageCount}} 张，主题 {{query}}。',
        referenceImagePaths: [referencePath],
      }),
      onCompleted({ promptTrace }) {
        completedPromptTrace = promptTrace;
      },
    });

    assert.equal(result.status, 'completed', result.error);
    assert.equal(textPrompts.length, 2);
    assert.match(textPrompts[0], /有参考图的玄关整理/);
    assert.match(textPrompts[0], /本任务最终交付 4 张图片/);
    assert.match(textPrompts[1], /视觉规划步骤/);
    assert.equal(imagePrompts.length, 4);
    imagePrompts.forEach((prompt, index) => {
      assert.match(prompt, new RegExp(`生成第 ${index + 1} 张，共 4 张`));
      assert.match(prompt, /桌面总是收完没两天又乱/);
      assert.match(prompt, /直接生成包含完整图文排版的最终页面/u);
      assert.match(prompt, /整套图片由图像模型一次性完成场景与文字排版/u);
      assert.match(prompt, /逐字渲染 allowedVisibleText/u);
      assert.doesNotMatch(prompt, /不得生成任何可见文字/u);
    });
    assert.deepEqual(imageInputPaths[0], [referencePath]);
    for (const paths of imageInputPaths.slice(1)) {
      assert.ok(paths.includes(referencePath));
      assert.ok(paths.some((path) => path.endsWith('.style-reference.png')));
      assert.ok(paths.every((path) => !path.endsWith('01-hero.png')));
    }
    assert.equal(completedPromptTrace.contentKind, 'USER_PROMPT');
    assert.equal(completedPromptTrace.text.status, 'SUBMITTED');
    assert.equal(completedPromptTrace.text.content, buildPostPrompt(task, { imageCount: 4 }));
    assert.notEqual(completedPromptTrace.text.content, textPrompts[0]);
    assert.doesNotMatch(completedPromptTrace.text.content, /围绕 有参考图的玄关整理/);
    assert.deepEqual(completedPromptTrace.images.map(({ pageIndex, status }) => ({ pageIndex, status })),
      imagePrompts.map((_content, index) => ({ pageIndex: index + 1, status: 'SUBMITTED' })));
    completedPromptTrace.images.forEach(({ content }, index) => {
      assert.match(content, /直接生成包含完整图文排版的最终页面/u);
      assert.doesNotMatch(content, /生成第 \d+ 张，共 4 张，主题/u);
      assert.ok(imagePrompts[index].includes(content));
    });
    const manifest = JSON.parse(await readFile(join(result.outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.images.length, 4);
    assert.ok(manifest.images.every((image) => image.provider === 'openclaw-image-edit'));
    assert.ok(manifest.images.every((image) => !Object.hasOwn(image, 'prompt')),
      '交付清单不得泄露内部完整提示词');
  });

  it('uses the content-selected image count throughout a live delivery', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '内容较多，需要四张图讲清楚' });
    const post = createMockPost(4);
    const rawImages = await Promise.all(['#d7c7b0', '#c7d7b0', '#b0c7d7', '#d7b0c7'].map((background) => sharp({
      create: { width: 1024, height: 1536, channels: 3, background },
    }).png().toBuffer()));
    const textPrompts = [];
    let imageCalls = 0;
    let completion;
    const openclaw = {
      runText({ prompt }) {
        textPrompts.push(prompt);
        return {
          rawText: JSON.stringify(
            prompt.includes('视觉规划步骤') ? createMockVisualPlan(post, { imageCount: 4 }) : post,
          ),
          model: 'fake-text',
        };
      },
      runImage({ outputPath }) {
        writeFileSync(outputPath, rawImages[imageCalls]);
        imageCalls += 1;
        return { outputPath, model: 'fake-image' };
      },
      runImageEdit({ outputPath }) {
        writeFileSync(outputPath, rawImages[imageCalls]);
        imageCalls += 1;
        return { outputPath, model: 'fake-image-edit' };
      },
      runVision({ prompt }) {
        return { rawText: JSON.stringify(passingVisionOutput(prompt)), model: 'fake-vision' };
      },
    };

    const result = await processNext({
      queue,
      workerId: 'dynamic-count-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
      onCompleted(payload) {
        completion = payload;
      },
    });

    assert.equal(result.status, 'completed', result.error);
    assert.match(textPrompts[0], /3[–-]5 张/);
    assert.equal(imageCalls, 4);
    assert.equal(completion.imageCount, 4);
    const manifest = JSON.parse(await readFile(join(result.outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.imageCount, 4);
    assert.equal(manifest.images.length, 4);
  });

  it('reselects the image count after a manual text revision', async () => {
    const { directory, queue } = await setup();
    queue.enqueue({ query: '人工改稿后重新规划图片数量' });
    const previousPost = createMockPost(3);
    const replannedPost = { ...previousPost, imagePlan: createMockPost(5).imagePlan };
    const rawImages = await Promise.all(['#d7c7b0', '#c7d7b0', '#b0c7d7', '#d7b0c7', '#c7b0d7'].map((background) => sharp({
      create: { width: 1024, height: 1536, channels: 3, background },
    }).png().toBuffer()));
    let imageCalls = 0;
    let dynamicPlanCalls = 0;
    let completion;
    const openclaw = {
      runText({ prompt }) {
        if (prompt.includes('图片分页规划步骤')) {
          dynamicPlanCalls += 1;
          if (dynamicPlanCalls === 1) {
            const invalidPlan = structuredClone(replannedPost.imagePlan);
            invalidPlan[4].bullets[invalidPlan[4].bullets.length - 1] = '超'.repeat(31);
            return { rawText: JSON.stringify({ imagePlan: invalidPlan }), model: 'fake-count-planner' };
          }
          assert.match(prompt, /上一次图片分页规划输出未通过结构校验/u);
          assert.match(prompt, /cannot exceed 30 characters/u);
          return { rawText: JSON.stringify({ imagePlan: replannedPost.imagePlan }), model: 'fake-count-planner' };
        }
        return {
          rawText: JSON.stringify(createMockVisualPlan(replannedPost, { imageCount: 5 })),
          model: 'fake-visual-planner',
        };
      },
      runImage({ outputPath }) {
        writeFileSync(outputPath, rawImages[imageCalls]);
        imageCalls += 1;
        return { outputPath, model: 'fake-image' };
      },
      runImageEdit({ outputPath }) {
        writeFileSync(outputPath, rawImages[imageCalls]);
        imageCalls += 1;
        return { outputPath, model: 'fake-image-edit' };
      },
      runVision({ prompt }) {
        return { rawText: JSON.stringify(passingVisionOutput(prompt)), model: 'fake-vision' };
      },
    };

    const result = await processNext({
      queue,
      workerId: 'manual-dynamic-count-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
      configProvider: () => ({
        imageCount: 3,
        imageCountMode: 'auto',
        currentTextRevisionId: 88,
        postOverride: previousPost,
      }),
      onCompleted(payload) {
        completion = payload;
      },
    });

    assert.equal(result.status, 'completed', result.error);
    assert.equal(dynamicPlanCalls, 2);
    assert.equal(completion.imageCount, 5);
    assert.equal(completion.sourceTextRevisionId, 88);
    assert.equal(imageCalls, 5);
  });
});
