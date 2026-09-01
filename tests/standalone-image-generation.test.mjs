import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    let liveCalls = 0;
    const progressEvents = [];
    try {
      const result = await generateStandaloneImages({
        source: validSource(),
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
      assert.equal(progressEvents[0].stage, 'PREPARING');
      assert.equal(progressEvents.at(-1).stage, 'COMPLETED');
      assert.equal(progressEvents.at(-1).progressPercent, 100);
      assert.ok(progressEvents.some((progress) => progress.stage === 'GENERATING'));
      assert.ok(progressEvents.some((progress) => progress.stage === 'QUALITY_CHECK'));
      assert.deepEqual(
        progressEvents.map((progress) => progress.progressPercent),
        [...progressEvents.map((progress) => progress.progressPercent)].sort((left, right) => left - right),
      );

      const progress = await readStandaloneImageProgress({ outputRoot, runId: RUN_ID });
      assert.equal(progress.status, 'COMPLETED');
      assert.equal(progress.completedImages, 3);
      assert.equal(progress.totalImages, 3);
      assert.equal(progress.estimatedRemainingMs, 0);
      assert.equal(progress.result.runId, RUN_ID);

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
        join(outputRoot, 'standalone-image-generations', RUN_ID, 'result.json'),
        'utf8',
      ));
      assert.equal(manifest.runId, RUN_ID);
      assert.equal(manifest.images.length, 3);
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
