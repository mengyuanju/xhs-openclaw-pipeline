import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import sharp from 'sharp';

import { createMockPost } from '../src/pipeline.mjs';
import {
  StandaloneImageConfirmationError,
  assertStandaloneImageConfirmation,
  estimateStandaloneImageDuration,
  generateStandaloneImages,
  normalizeStandaloneImageSource,
  readStandaloneImageFile,
  readStandaloneImageProgress,
} from '../src/standalone-image-generation.mjs';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const FALLBACK_RUN_ID = '22222222-2222-4222-8222-222222222222';
const FAILURE_RUN_ID = '33333333-3333-4333-8333-333333333333';

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

function validSource(imageCount = 3) {
  const post = createMockPost(imageCount);
  return {
    query: '租房桌面怎么低成本整理？',
    copy: {
      title: post.title,
      body: post.body,
      tags: post.tags,
    },
    imagePlan: post.imagePlan,
  };
}

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

function qualityAssessment() {
  return {
    schemaVersion: 1,
    dimensions: Object.fromEntries(QUALITY_DIMENSIONS.map((name) => [name, {
      score: 3,
      evidence: [`终审证据 ${name}=3`],
      applicable: true,
    }])),
    issueLabels: [],
    typeAdjustments: [],
  };
}

function liveClient({ runText }) {
  let imageIndex = 0;
  const writeGeneratedImage = async (outputPath) => {
    imageIndex += 1;
    await sharp({
      create: {
        width: 1086,
        height: 1448,
        channels: 3,
        background: {
          r: 80 + imageIndex * 20,
          g: 130 + imageIndex * 10,
          b: 170 - imageIndex * 10,
        },
      },
    }).png().toFile(outputPath);
    return { outputPath, model: 'fake-image' };
  };
  return {
    runText,
    runImage({ outputPath }) {
      return writeGeneratedImage(outputPath);
    },
    runImageEdit({ outputPath }) {
      return writeGeneratedImage(outputPath);
    },
    runVision({ prompt }) {
      const output = prompt.includes('独立于生成模型的图文交付终审员')
        ? qualityAssessment()
        : passingAlignment(prompt);
      return { rawText: JSON.stringify(output), model: 'fake-vision' };
    },
  };
}

describe('standalone image generation service', () => {
  it('normalizes manually supplied copy and image plans through the production post contract', () => {
    const post = normalizeStandaloneImageSource(validSource(4));

    assert.equal(post.imagePlan.length, 4);
    assert.equal(post.imagePlan[0].kind, 'hero');
    assert.equal(post.fabricatedExperience, false);
    assert.deepEqual(post.sources, []);

    const invalid = validSource();
    invalid.imagePlan[0] = { ...invalid.imagePlan[0], kind: 'steps' };
    assert.throws(() => normalizeStandaloneImageSource(invalid), /first item must be hero/u);
  });

  it('accepts a finalized copy when its historical query matches the approved title', () => {
    const source = validSource();
    source.query = source.copy.title;

    const post = normalizeStandaloneImageSource(source);

    assert.equal(post.title, source.copy.title);
    assert.equal(post.imagePlan.length, source.imagePlan.length);
  });

  it('requires explicit cost confirmation only for Live mode', () => {
    assert.doesNotThrow(() => assertStandaloneImageConfirmation('MOCK'));
    assert.doesNotThrow(() => assertStandaloneImageConfirmation('LIVE', 'LIVE_IMAGE_COST_ACCEPTED'));
    assert.throws(
      () => assertStandaloneImageConfirmation('LIVE'),
      StandaloneImageConfirmationError,
    );
    assert.throws(
      () => assertStandaloneImageConfirmation('MOCK', 'LIVE_IMAGE_COST_ACCEPTED'),
      /Mock mode does not accept Live confirmation/u,
    );
  });

  it('estimates Live runs by page count and keeps Mock estimates short', () => {
    const mockEstimate = estimateStandaloneImageDuration({ mode: 'MOCK', imageCount: 3 });
    const liveThreePageEstimate = estimateStandaloneImageDuration({ mode: 'LIVE', imageCount: 3 });
    const liveFivePageEstimate = estimateStandaloneImageDuration({ mode: 'LIVE', imageCount: 5 });

    assert.ok(mockEstimate >= 1_000);
    assert.ok(liveThreePageEstimate > mockEstimate);
    assert.ok(liveFivePageEstimate > liveThreePageEstimate);
  });

  it('renders an isolated Mock run with distinct delivery-sized PNG files and a manifest', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'standalone-image-generation-'));
    const source = validSource();
    let liveCalls = 0;
    const progressEvents = [];
    try {
      const result = await generateStandaloneImages({
        source,
        mode: 'MOCK',
        outputRoot,
        runId: RUN_ID,
        onProgress(progress) {
          progressEvents.push(progress);
        },
        runtime: {
          client: {
            async runImage() {
              liveCalls += 1;
              throw new Error('Mock mode must not call the image model');
            },
          },
        },
      });

      assert.equal(liveCalls, 0);
      assert.equal(result.runId, RUN_ID);
      assert.equal(result.mode, 'MOCK');
      assert.equal(result.status, 'BLOCKED');
      assert.equal(result.imageCount, 3);
      assert.equal(result.images.length, 3);
      assert.equal(result.qc.passed, false);
      assert.equal(result.visualPlan.model, null);
      assert.equal(result.visualPlan.degraded, false);
      assert.equal(result.visualPlan.warning, null);
      assert.equal(result.images[0].layout.layoutTemplate, 'HERO_LEFT');
      assert.equal(result.images[0].layout.allowedVisibleText.headline, source.imagePlan[0].headline);
      assert.deepEqual(result.images[0].layout.allowedVisibleText.bullets, source.imagePlan[0].bullets);
      assert.equal(result.qc.disposition, 'mock_only');
      assert.equal(result.qc.action, 'return_for_revision');
      assert.ok(result.qc.issues.some((issue) => issue.label === '图片来源-Mock'));
      assert.ok(result.qc.dimensions.some((dimension) => dimension.key === 'imageBaseQuality'));
      assert.ok(result.qc.limitations.length > 0);
      assert.equal(progressEvents[0].stage, 'PREPARING');
      assert.equal(progressEvents.at(-1).stage, 'COMPLETED');
      assert.equal(progressEvents.at(-1).progressPercent, 100);
      assert.ok(progressEvents.some((progress) => progress.stage === 'GENERATING'));
      assert.ok(progressEvents.some((progress) => progress.stage === 'QUALITY_CHECK'));
      assert.deepEqual(
        progressEvents.map((progress) => progress.progressPercent),
        [...progressEvents.map((progress) => progress.progressPercent)].sort((left, right) => left - right),
      );

      const runDirectory = join(outputRoot, 'standalone-image-generations', RUN_ID);
      const progressPath = join(runDirectory, 'progress.json');
      const legacyProgress = JSON.parse(await readFile(progressPath, 'utf8'));
      delete legacyProgress.result.visualPlan;
      delete legacyProgress.result.qc.disposition;
      delete legacyProgress.result.qc.action;
      delete legacyProgress.result.qc.issues;
      delete legacyProgress.result.qc.dimensions;
      delete legacyProgress.result.qc.limitations;
      for (const image of legacyProgress.result.images) delete image.layout;
      await writeFile(progressPath, `${JSON.stringify(legacyProgress, null, 2)}\n`, 'utf8');

      const progress = await readStandaloneImageProgress({ outputRoot, runId: RUN_ID });
      assert.equal(progress.status, 'COMPLETED');
      assert.equal(progress.completedImages, 3);
      assert.equal(progress.totalImages, 3);
      assert.equal(progress.estimatedRemainingMs, 0);
      assert.equal(progress.result.runId, RUN_ID);
      assert.equal(progress.result.images[0].layout.layoutTemplate, 'HERO_LEFT');
      assert.equal(progress.result.visualPlan.degraded, false);
      assert.equal(progress.result.qc.disposition, 'mock_only');
      assert.ok(progress.result.qc.dimensions.length > 0);

      const hashes = new Set();
      for (const image of result.images) {
        assert.match(image.url, new RegExp(`/api/image-generations/${RUN_ID}/images/`));
        const file = await readStandaloneImageFile({
          outputRoot,
          runId: RUN_ID,
          file: image.file,
        });
        const metadata = await sharp(file.content).metadata();
        assert.equal(metadata.format, 'png');
        assert.equal(metadata.width, 1086);
        assert.equal(metadata.height, 1448);
        hashes.add(createHash('sha256').update(file.content).digest('hex'));
      }
      assert.equal(hashes.size, 3);

      const manifest = JSON.parse(await readFile(
        join(runDirectory, 'result.json'),
        'utf8',
      ));
      assert.equal(manifest.runId, RUN_ID);
      assert.equal(manifest.images.length, 3);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it('falls back to a deterministic visual plan when Live text planning loses its socket', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'standalone-image-fallback-'));
    try {
      const result = await generateStandaloneImages({
        source: validSource(),
        mode: 'LIVE',
        outputRoot,
        runId: FALLBACK_RUN_ID,
        runtime: {
          client: liveClient({
            async runText() {
              throw new Error('OpenClaw text inference failed: UND_ERR_SOCKET terminated');
            },
          }),
          imageConcurrency: 1,
        },
      });

      assert.equal(result.runId, FALLBACK_RUN_ID);
      assert.equal(result.images.length, 3);
      assert.equal(result.visualPlan.model, 'deterministic-transport-fallback');
      assert.equal(result.visualPlan.degraded, true);
      assert.equal(result.visualPlan.warning.code, 'VISUAL_PLAN_TRANSPORT_FALLBACK');
      assert.equal(result.images[1].layout.layoutTemplate, 'STEPS_LEFT');
      assert.equal(result.qc.disposition, 'manual_review_required');
      assert.equal(result.qc.action, 'priority_review');
      assert.equal(
        result.qc.dimensions.find((dimension) => dimension.key === 'imageTextQuality').score,
        3,
      );
      assert.match(
        result.qc.dimensions.find((dimension) => dimension.key === 'imageTextQuality').evidence.join('\n'),
        /终审证据/u,
      );
      const runDirectory = join(
        outputRoot,
        'standalone-image-generations',
        FALLBACK_RUN_ID,
      );
      const storedPlan = JSON.parse(await readFile(join(runDirectory, 'visual-plan.json'), 'utf8'));
      assert.equal(storedPlan.model, 'deterministic-transport-fallback');
      assert.equal(storedPlan.degraded, true);
      assert.equal(storedPlan.warning.code, 'VISUAL_PLAN_TRANSPORT_FALLBACK');

      const progress = await readStandaloneImageProgress({
        outputRoot,
        runId: FALLBACK_RUN_ID,
      });
      assert.equal(progress.status, 'COMPLETED');
      assert.ok(progress.warnings.some(
        (warning) => warning.code === 'VISUAL_PLAN_TRANSPORT_FALLBACK',
      ));
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it('persists the failed stage and a redacted root cause for unrecoverable Live failures', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'standalone-image-diagnostic-'));
    const fakeSecret = 'sk-test-secret-value-123456789';
    try {
      await assert.rejects(
        generateStandaloneImages({
          source: validSource(),
          mode: 'LIVE',
          outputRoot,
          runId: FAILURE_RUN_ID,
          runtime: {
            client: liveClient({
              async runText() {
                throw new Error(`401 unauthorized api_key=${fakeSecret}`);
              },
            }),
          },
        }),
        (error) => {
          assert.match(error.message, /视觉规划失败/u);
          assert.doesNotMatch(error.message, new RegExp(fakeSecret, 'u'));
          return true;
        },
      );

      const runDirectory = join(
        outputRoot,
        'standalone-image-generations',
        FAILURE_RUN_ID,
      );
      const source = JSON.parse(await readFile(join(runDirectory, 'source.json'), 'utf8'));
      assert.equal(source.query, validSource().query);

      const progress = await readStandaloneImageProgress({
        outputRoot,
        runId: FAILURE_RUN_ID,
      });
      assert.equal(progress.status, 'FAILED');
      assert.equal(progress.diagnostic.stage, 'PLANNING');
      assert.equal(progress.diagnostic.code, 'PLANNING_FAILED');
      assert.match(progress.diagnostic.message, /401 unauthorized/u);
      assert.doesNotMatch(progress.diagnostic.message, new RegExp(fakeSecret, 'u'));
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it('rejects path traversal and files not declared by the run manifest', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'standalone-image-path-'));
    try {
      await generateStandaloneImages({
        source: validSource(),
        mode: 'MOCK',
        outputRoot,
        runId: RUN_ID,
      });

      await assert.rejects(
        readStandaloneImageFile({ outputRoot, runId: '../escape', file: '01-hero.png' }),
        /run id is invalid/u,
      );
      await assert.rejects(
        readStandaloneImageFile({ outputRoot, runId: RUN_ID, file: '../result.json' }),
        /file name is invalid/u,
      );
      await assert.rejects(
        readStandaloneImageFile({ outputRoot, runId: RUN_ID, file: '99-summary.png' }),
        /image is not part of this run/u,
      );
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
