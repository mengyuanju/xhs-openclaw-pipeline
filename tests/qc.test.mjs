import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import sharp from 'sharp';

import { evaluateDelivery } from '../src/qc.mjs';

const RUBRIC_DIMENSIONS = [
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

function post(overrides = {}) {
  return {
    title: '租房桌面整理方法',
    body: '先清空桌面，再按使用频率分类，最后给高频物品固定位置。'.repeat(10),
    fabricatedExperience: false,
    riskFlags: [],
    unverifiedClaims: [],
    expressionReferences: ['https://example.com/reference'],
    platform: { sampleEvidence: 'limited', iconDictionary: {} },
    ...overrides,
  };
}

async function writePng(path, color) {
  await sharp({ create: { width: 1080, height: 1440, channels: 3, background: color } })
    .png()
    .toFile(path);
}

function completeRubricAssessment(score = 3) {
  return {
    dimensions: Object.fromEntries(RUBRIC_DIMENSIONS.map((name) => [name, {
      score,
      evidence: [`人工复核 ${name}=${score}`],
      source: 'human',
      applicable: true,
    }])),
    issueLabels: [],
    typeAdjustments: [],
  };
}

describe('delivery quality checks', () => {
  it('treats the 400–600 character target as advisory rather than a hard failure', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'xhs-qc-'));
    try {
      const images = [
        { file: '01.png', provider: 'openclaw', alignment: { passed: true, failureClass: 'PASS' } },
        { file: '02.png', provider: 'openclaw-image-edit', alignment: { passed: true, failureClass: 'PASS' } },
        { file: '03.png', provider: 'openclaw-image-edit', alignment: { passed: true, failureClass: 'PASS' } },
      ];
      await Promise.all([
        writePng(join(outputDir, '01.png'), '#ff0000'),
        writePng(join(outputDir, '02.png'), '#00ff00'),
        writePng(join(outputDir, '03.png'), '#0000ff'),
      ]);

      const qc = await evaluateDelivery({
        post: post({ body: '先清空，再分类，最后复位。'.repeat(20) }),
        images,
        outputDir,
        mode: 'live',
      });

      const recommendedLength = qc.checks.find(({ id }) => id === 'body_recommended_length');
      assert.equal(recommendedLength.passed, false);
      assert.equal(recommendedLength.blocking, false);
      assert.equal(qc.disposition, 'manual_review_required');
      assert.equal(qc.overallScore, 2);
      assert.equal(qc.rubric.ruleId, 'production-v2');
      assert.equal(qc.rubric.finalScore, 2);
      assert.equal(qc.rubric.dimensions.imageBaseQuality.score, 2);
      assert.ok(qc.rubric.lowestObstacleDimensions.length > 0);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('blocks forbidden title hooks and byte-identical delivery images', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'xhs-qc-'));
    try {
      const source = join(outputDir, '01.png');
      await writePng(source, '#ff0000');
      await sharp(source).toFile(join(outputDir, '02.png'));
      await writePng(join(outputDir, '03.png'), '#0000ff');
      const images = [
        { file: '01.png', provider: 'openclaw', alignment: { passed: true, failureClass: 'PASS' } },
        { file: '02.png', provider: 'openclaw-image-edit', alignment: { passed: true, failureClass: 'PASS' } },
        { file: '03.png', provider: 'openclaw-image-edit', alignment: { passed: true, failureClass: 'PASS' } },
      ];

      const qc = await evaluateDelivery({
        post: post({ title: '一篇看懂桌面整理' }),
        images,
        outputDir,
        mode: 'live',
      });

      assert.equal(qc.checks.find(({ id }) => id === 'title_quality').passed, false);
      assert.equal(qc.checks.find(({ id }) => id === 'duplicate_images').passed, false);
      assert.equal(qc.disposition, 'blocked');
      assert.equal(qc.rubric.finalScore, 1);
      assert.equal(qc.rubric.stoppedAt, 'satisfaction');
      assert.equal(qc.rubric.dimensions.contentOriginality.score, 1);
      assert.ok(qc.issues.some(({ label }) => label === '内容-标题问题'));
      assert.ok(qc.issues.some(({ label }) => label === '配图-重复配图'));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('blocks a live delivery when any image did not come from the image model', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'xhs-qc-'));
    try {
      const images = [
        { file: '01.png', provider: 'openclaw', alignment: { passed: true, failureClass: 'PASS' } },
        { file: '02.png', provider: 'local-template', alignment: { passed: true, failureClass: 'PASS' } },
        { file: '03.png', provider: 'openclaw-image-edit', alignment: { passed: true, failureClass: 'PASS' } },
      ];
      await Promise.all([
        writePng(join(outputDir, '01.png'), '#ff0000'),
        writePng(join(outputDir, '02.png'), '#00ff00'),
        writePng(join(outputDir, '03.png'), '#0000ff'),
      ]);

      const qc = await evaluateDelivery({ post: post(), images, outputDir, mode: 'live' });

      assert.equal(qc.checks.find(({ id }) => id === 'model_image_sources').passed, false);
      assert.equal(qc.disposition, 'blocked');
      assert.equal(qc.rubric.finalScore, 1);
      assert.equal(qc.rubric.stoppedAt, 'usability');
      assert.equal(qc.rubric.dimensions.imageBaseQuality.score, 1);
      assert.ok(qc.issues.some(({ label }) => label === '图片来源-非模型生成'));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('awards 3 when complete direct expert evidence raises every passing dimension to 3', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'xhs-qc-'));
    try {
      const images = [
        { file: '01.png', provider: 'openclaw', alignment: { passed: true, failureClass: 'PASS' } },
        { file: '02.png', provider: 'openclaw-image-edit', alignment: { passed: true, failureClass: 'PASS' } },
        { file: '03.png', provider: 'openclaw-image-edit', alignment: { passed: true, failureClass: 'PASS' } },
      ];
      await Promise.all([
        writePng(join(outputDir, '01.png'), '#ff0000'),
        writePng(join(outputDir, '02.png'), '#00ff00'),
        writePng(join(outputDir, '03.png'), '#0000ff'),
      ]);

      const qc = await evaluateDelivery({
        post: post({
          platform: { sampleEvidence: 'limited', iconDictionary: {} },
          expressionReferences: ['https://example.com/sufficient-reference'],
        }),
        images,
        outputDir,
        mode: 'live',
        rubricAssessment: completeRubricAssessment(3),
      });

      assert.equal(qc.overallScore, 3);
      assert.equal(qc.disposition, 'manual_review_required');
      assert.equal(qc.rubric.finalScore, 3);
      assert.equal(qc.rubric.action, 'priority_review');
      assert.deepEqual(qc.rubric.lowestObstacleDimensions, []);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('maps an explicit redline assessment to score 0 and a blocked disposition', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'xhs-qc-'));
    try {
      const images = [
        { file: '01.png', provider: 'openclaw', alignment: { passed: true, failureClass: 'PASS' } },
        { file: '02.png', provider: 'openclaw-image-edit', alignment: { passed: true, failureClass: 'PASS' } },
        { file: '03.png', provider: 'openclaw-image-edit', alignment: { passed: true, failureClass: 'PASS' } },
      ];
      await Promise.all([
        writePng(join(outputDir, '01.png'), '#ff0000'),
        writePng(join(outputDir, '02.png'), '#00ff00'),
        writePng(join(outputDir, '03.png'), '#0000ff'),
      ]);
      const rubricAssessment = completeRubricAssessment(3);
      rubricAssessment.issueLabels.push({
        severity: 'redline',
        label: '隐私泄露',
        evidence: '人工确认图片含未处理身份证件',
      });

      const qc = await evaluateDelivery({
        post: post({
          platform: { sampleEvidence: 'sufficient', iconDictionary: {} },
          expressionReferences: ['https://example.com/sufficient-reference'],
        }),
        images,
        outputDir,
        mode: 'live',
        rubricAssessment,
      });

      assert.equal(qc.overallScore, 0);
      assert.equal(qc.disposition, 'blocked');
      assert.equal(qc.rubric.finalScore, 0);
      assert.equal(qc.rubric.action, 'redline_block');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid evidence source before merging external rubric scores', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'xhs-qc-'));
    try {
      const images = [
        { file: '01.png', provider: 'openclaw', alignment: { passed: true, failureClass: 'PASS' } },
        { file: '02.png', provider: 'openclaw-image-edit', alignment: { passed: true, failureClass: 'PASS' } },
        { file: '03.png', provider: 'openclaw-image-edit', alignment: { passed: true, failureClass: 'PASS' } },
      ];
      await Promise.all([
        writePng(join(outputDir, '01.png'), '#ff0000'),
        writePng(join(outputDir, '02.png'), '#00ff00'),
        writePng(join(outputDir, '03.png'), '#0000ff'),
      ]);
      const rubricAssessment = completeRubricAssessment(3);
      rubricAssessment.dimensions.noteTone.source = 'forged';

      await assert.rejects(
        () => evaluateDelivery({
          post: post(),
          images,
          outputDir,
          mode: 'live',
          rubricAssessment,
        }),
        /noteTone\.source is invalid/,
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
