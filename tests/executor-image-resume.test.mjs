import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import { createExecutorAgent, executeImageClaim } from '../src/executor/agent.mjs';
import { createMockPost } from '../src/pipeline.mjs';
import { createMockVisualPlan } from '../src/visual-plan.mjs';

const FIRST_RUN_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_RUN_ID = '22222222-2222-4222-8222-222222222222';
const THIRD_RUN_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = 17;
const QUALITY_DIMENSIONS = [
  'queryRelevance', 'contentOriginality', 'imageBaseQuality', 'imageTextQuality',
  'imageConsistency', 'noteTone', 'platformAdaptation', 'informationValue',
  'imageAesthetics', 'imageDiversity',
];

function imageClaim(id, recoveryRunIds = []) {
  const post = createMockPost(3);
  const query = '租房桌面怎么低成本整理？';
  return {
    task: { id: TASK_ID },
    execution: {
      id,
      nodeId: 'image-node',
      snapshot: {
        task: { query },
        prompts: { IMAGE_SYSTEM: { content: '生成一套清晰、准确的中文图文页面。' } },
        knowledge: [],
        copyRevision: {
          content: {
            query,
            copy: { title: post.title, body: post.body, tags: post.tags },
            imagePlan: post.imagePlan,
          },
        },
        ...(recoveryRunIds.length > 0 ? {
          imageRecovery: { nodeId: 'image-node', runIds: recoveryRunIds },
        } : {}),
      },
    },
  };
}

function generatingImageClient() {
  let imageIndex = 0;
  async function generate({ outputPath }) {
    imageIndex += 1;
    await sharp({
      create: {
        width: 1086,
        height: 1448,
        channels: 3,
        background: { r: 80 + imageIndex * 20, g: 130 + imageIndex * 10, b: 170 - imageIndex * 10 },
      },
    }).png().toFile(outputPath);
    return { outputPath, model: 'fake-image' };
  }
  return {
    async runText() {
      return {
        rawText: JSON.stringify(createMockVisualPlan(createMockPost(3), { imageCount: 3 })),
        model: 'fake-planner',
      };
    },
    runImage: generate,
    runImageEdit: generate,
    async runVision({ prompt }) {
      if (prompt.includes('独立于生成模型的图文交付终审员')) {
        return {
          rawText: JSON.stringify({
            schemaVersion: 1,
            dimensions: Object.fromEntries(QUALITY_DIMENSIONS.map((name) => [name, {
              score: 3, evidence: [`终审证据 ${name}=3`], applicable: true,
            }])),
            issueLabels: [],
            typeAdjustments: [],
          }),
          model: 'fake-quality',
        };
      }
      const contract = JSON.parse(prompt.match(
        /<untrusted_alignment_contract>\n([\s\S]+?)\n<\/untrusted_alignment_contract>/u,
      )[1]);
      const allowed = contract.page.allowedVisibleText;
      return {
        rawText: JSON.stringify({
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
        }),
        model: 'fake-alignment',
      };
    },
  };
}

function noFurtherModelCalls() {
  return Object.fromEntries(['runText', 'runImage', 'runImageEdit', 'runVision'].map((method) => [
    method, async () => assert.fail(`completed image delivery must not call ${method} again`),
  ]));
}

test('executor resumes a failed second upload without repeating model work or the first upload', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'executor-resume-upload-'));
  const uploads = [];
  const completions = [];
  const files = createMockPost(3).imagePlan.map((page, index) =>
    `${String(index + 1).padStart(2, '0')}-${page.kind}.png`);
  const controlPlane = {
    async updateProgress() {},
    async uploadAsset(executionId, { fileName, mediaType, content }) {
      uploads.push({ executionId, fileName });
      assert.equal(mediaType, 'image/png');
      const metadata = await sharp(content).metadata();
      assert.equal(metadata.width, 1086);
      assert.equal(metadata.height, 1448);
      if (executionId === FIRST_RUN_ID && fileName === files[1]) {
        throw new Error('simulated second upload failure');
      }
      const id = 100 + uploads.length;
      return { id, url: `/v1/assets/${id}` };
    },
    async completeImage(executionId, result) {
      completions.push({ executionId, result });
      return { accepted: true };
    },
  };
  try {
    await assert.rejects(executeImageClaim({
      claim: imageClaim(FIRST_RUN_ID), controlPlane, workRoot, imageClient: generatingImageClient(),
    }), /simulated second upload failure/u);
    assert.equal(completions.length, 0);
    await access(join(workRoot, String(TASK_ID)));

    const completed = await executeImageClaim({
      claim: imageClaim(SECOND_RUN_ID, [FIRST_RUN_ID]),
      controlPlane,
      workRoot,
      imageClient: noFurtherModelCalls(),
    });

    assert.deepEqual(completed, { accepted: true });
    assert.deepEqual(uploads, [
      { executionId: FIRST_RUN_ID, fileName: files[0] },
      { executionId: FIRST_RUN_ID, fileName: files[1] },
      { executionId: SECOND_RUN_ID, fileName: files[1] },
      { executionId: SECOND_RUN_ID, fileName: files[2] },
    ]);
    assert.equal(completions.length, 1);
    assert.equal(completions[0].executionId, SECOND_RUN_ID);
    assert.equal(completions[0].result.runId, SECOND_RUN_ID);
    assert.equal(completions[0].result.images[0].assetId, 101);
    assert.equal(completions[0].result.images[0].url, '/v1/assets/101');
    await assert.rejects(access(join(workRoot, String(TASK_ID))), { code: 'ENOENT' });
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('executor retries completion reports across three runs without regenerating or reuploading images', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'executor-resume-completion-'));
  const uploads = [];
  const completions = [];
  const controlPlane = {
    async updateProgress() {},
    async uploadAsset(executionId, { fileName }) {
      uploads.push({ executionId, fileName });
      const id = 200 + uploads.length;
      return { id, url: `/v1/assets/${id}` };
    },
    async completeImage(executionId, result) {
      completions.push({ executionId, result });
      if (completions.length < 3) throw new Error('simulated completion report failure');
      return { accepted: true };
    },
  };
  try {
    await assert.rejects(executeImageClaim({
      claim: imageClaim(FIRST_RUN_ID), controlPlane, workRoot, imageClient: generatingImageClient(),
    }), /simulated completion report failure/u);
    await assert.rejects(executeImageClaim({
      claim: imageClaim(SECOND_RUN_ID, [FIRST_RUN_ID]),
      controlPlane,
      workRoot,
      imageClient: noFurtherModelCalls(),
    }), /simulated completion report failure/u);
    await access(join(workRoot, String(TASK_ID)));

    const completed = await executeImageClaim({
      claim: imageClaim(THIRD_RUN_ID, [SECOND_RUN_ID, FIRST_RUN_ID]),
      controlPlane,
      workRoot,
      imageClient: noFurtherModelCalls(),
    });

    assert.deepEqual(completed, { accepted: true });
    assert.equal(uploads.length, 3);
    assert.ok(uploads.every((upload) => upload.executionId === FIRST_RUN_ID));
    assert.deepEqual(completions.map(({ executionId }) => executionId), [
      FIRST_RUN_ID, SECOND_RUN_ID, THIRD_RUN_ID,
    ]);
    for (const { executionId, result } of completions) {
      assert.equal(result.runId, executionId);
      assert.deepEqual(result.images.map((image) => image.assetId), [201, 202, 203]);
    }
    await assert.rejects(access(join(workRoot, String(TASK_ID))), { code: 'ENOENT' });
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('executor reports a missing recovery checkpoint without starting a new generation', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'executor-resume-missing-'));
  try {
    await assert.rejects(executeImageClaim({
      claim: imageClaim(SECOND_RUN_ID, [FIRST_RUN_ID]),
      workRoot,
      imageClient: noFurtherModelCalls(),
      controlPlane: {
        async updateProgress() { assert.fail('missing recovery must fail before starting work'); },
        async uploadAsset() { assert.fail('missing recovery must not upload assets'); },
        async completeImage() { assert.fail('missing recovery must not report success'); },
      },
    }), /图片检查点缺失/u);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('executor abandons a stale lease during alignment without further model calls', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'executor-stale-image-'));
  const stale = Object.assign(new Error('execution lease was replaced'), { code: 'STALE_EXECUTION' });
  const originalClient = generatingImageClient();
  const calls = [];
  let leaseReplaced = false;
  const imageClient = Object.fromEntries(Object.entries(originalClient).map(([method, operation]) => [
    method,
    async (input) => {
      assert.equal(leaseReplaced, false, `stale execution must not call ${method}`);
      calls.push(method);
      return operation(input);
    },
  ]));
  const failures = [];
  const agent = createExecutorAgent({
    nodeId: 'image-node',
    imageWorkerEnabled: true,
    workRoot,
    readinessCheck: async () => {},
    executeImage: (input) => executeImageClaim({ ...input, imageClient }),
    controlPlane: {
      async claimImage() { return imageClaim(FIRST_RUN_ID); },
      async updateProgress(_executionId, progress) {
        if (progress.stage === 'ALIGNING') {
          leaseReplaced = true;
          throw stale;
        }
      },
      async failExecution(_executionId, error) { failures.push(error); },
      async uploadAsset() { assert.fail('stale execution must not upload assets'); },
      async completeImage() { assert.fail('stale execution must not report success'); },
    },
  });
  try {
    await agent.prepare();
    const result = await agent.runImageOnce();

    assert.equal(result.status, 'ABANDONED');
    assert.equal(result.error.code, 'STALE_EXECUTION');
    assert.deepEqual(calls, ['runText', 'runImage']);
    assert.ok(failures.every((error) => error.code === 'STALE_EXECUTION'));
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('executor uses the ancestor checkpoint when a newer run stopped during preparation', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'executor-resume-ancestor-'));
  const taskRoot = join(workRoot, String(TASK_ID));
  const uploads = [];
  const completions = [];
  const controlPlane = {
    async updateProgress() {},
    async uploadAsset(executionId, { fileName }) {
      assert.equal(executionId, FIRST_RUN_ID, 'the ancestor already uploaded every image');
      uploads.push(fileName);
      const id = 300 + uploads.length;
      return { id, url: `/v1/assets/${id}` };
    },
    async completeImage(executionId, result) {
      completions.push({ executionId, result });
      if (executionId === FIRST_RUN_ID) throw new Error('simulated completion report failure');
      return { accepted: true };
    },
  };
  try {
    await assert.rejects(executeImageClaim({
      claim: imageClaim(FIRST_RUN_ID), controlPlane, workRoot, imageClient: generatingImageClient(),
    }), /simulated completion report failure/u);

    const firstDirectory = join(taskRoot, 'standalone-image-generations', FIRST_RUN_ID);
    const interruptedDirectory = join(taskRoot, 'standalone-image-generations', SECOND_RUN_ID);
    const firstProgress = JSON.parse(await readFile(join(firstDirectory, 'progress.json'), 'utf8'));
    await mkdir(interruptedDirectory);
    await writeFile(join(interruptedDirectory, 'source.json'), await readFile(join(firstDirectory, 'source.json')));
    await writeFile(join(interruptedDirectory, 'progress.json'), JSON.stringify({
      ...firstProgress,
      runId: SECOND_RUN_ID,
      status: 'RUNNING',
      stage: 'PREPARING',
      progressPercent: 3,
      completedImages: 0,
      generatedImages: 0,
      validatedImages: 0,
      currentPage: null,
      finishedAt: null,
      diagnostic: null,
      result: null,
    }));

    const result = await executeImageClaim({
      claim: imageClaim(THIRD_RUN_ID, [SECOND_RUN_ID, FIRST_RUN_ID]),
      controlPlane,
      workRoot,
      imageClient: noFurtherModelCalls(),
    });

    assert.deepEqual(result, { accepted: true });
    assert.equal(uploads.length, 3);
    assert.equal(completions.length, 2);
    assert.equal(completions[1].result.runId, THIRD_RUN_ID);
    assert.deepEqual(completions[1].result.images.map((image) => image.assetId), [301, 302, 303]);
    await assert.rejects(access(taskRoot), { code: 'ENOENT' });
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});
