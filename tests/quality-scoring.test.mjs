import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scoreQualityAssessment } from '../src/quality-scoring.mjs';

const DIMENSION_NAMES = [
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

function dimension(score = 3, overrides = {}) {
  return {
    score,
    evidence: [`evidence for score ${score}`],
    source: 'human',
    applicable: true,
    ...overrides,
  };
}

function assessment(overrides = {}) {
  const dimensions = Object.fromEntries(DIMENSION_NAMES.map((name) => [name, dimension()]));
  return {
    dimensions,
    issueLabels: [],
    typeAdjustments: [],
    targetPlatform: '小红书',
    platformSampleEvidence: 'sufficient',
    ...overrides,
    dimensions: { ...dimensions, ...overrides.dimensions },
  };
}

describe('rule-document quality scoring', () => {
  it('awards 3 only when every applicable dimension is 3 with sufficient evidence', () => {
    const result = scoreQualityAssessment(assessment());

    assert.equal(result.ruleId, 'production-v2');
    assert.equal(result.finalScore, 3);
    assert.equal(result.action, 'priority_review');
    assert.equal(result.stoppedAt, 'complete');
    assert.deepEqual(result.layerScores, { satisfaction: 3, usability: 3, quality: 3 });
    assert.deepEqual(result.lowestObstacleDimensions, []);
  });

  it('awards 2 when any applicable dimension remains at 2', () => {
    const result = scoreQualityAssessment(assessment({
      dimensions: { noteTone: dimension(2, { evidence: ['语气略机械，但整体可用'] }) },
    }));

    assert.equal(result.finalScore, 2);
    assert.equal(result.action, 'normal_review');
    assert.equal(result.stoppedAt, 'complete');
    assert.deepEqual(result.lowestObstacleDimensions, ['noteTone']);
  });

  it('caps an otherwise perfect platform assessment at 2 when samples are missing', () => {
    const result = scoreQualityAssessment(assessment({ platformSampleEvidence: 'missing' }));

    assert.equal(result.finalScore, 2);
    assert.equal(result.dimensions.platformAdaptation.initialScore, 3);
    assert.equal(result.dimensions.platformAdaptation.score, 2);
    assert.equal(result.dimensions.platformAdaptation.cap, 'platform_samples_missing');
    assert.deepEqual(result.lowestObstacleDimensions, ['platformAdaptation']);
  });

  it('accepts a direct expert platform review without separate sample evidence', () => {
    const result = scoreQualityAssessment(assessment({
      platformSampleEvidence: 'direct_review',
    }));

    assert.equal(result.finalScore, 3);
    assert.equal(result.dimensions.platformAdaptation.score, 3);
    assert.equal(result.dimensions.platformAdaptation.cap, undefined);
  });

  it('awards 2 when all dimensions are 3 but a minor issue label remains', () => {
    const result = scoreQualityAssessment(assessment({
      issueLabels: [{ severity: 'minor', label: '轻微排版问题', evidence: '第 2 页间距略紧' }],
    }));

    assert.equal(result.finalScore, 2);
    assert.equal(result.action, 'normal_review');
    assert.deepEqual(result.lowestObstacleDimensions, ['issue:轻微排版问题']);
  });

  it('stops at satisfaction with score 1 when query relevance is below 2', () => {
    const input = assessment({
      dimensions: { queryRelevance: dimension(1, { evidence: ['只复述主题词，没有回答主需'] }) },
    });
    delete input.dimensions.imageAesthetics;

    const result = scoreQualityAssessment(input);

    assert.equal(result.finalScore, 1);
    assert.equal(result.action, 'return_for_revision');
    assert.equal(result.stoppedAt, 'satisfaction');
    assert.deepEqual(result.layerScores, { satisfaction: 1, usability: null, quality: null });
    assert.deepEqual(result.lowestObstacleDimensions, ['queryRelevance']);
  });

  it('stops at usability with score 1 when a base dimension is below 2', () => {
    const input = assessment({
      dimensions: { imageBaseQuality: dimension(1, { evidence: ['多张图中文字不可辨认'] }) },
    });
    delete input.dimensions.imageAesthetics;

    const result = scoreQualityAssessment(input);

    assert.equal(result.finalScore, 1);
    assert.equal(result.stoppedAt, 'usability');
    assert.deepEqual(result.layerScores, { satisfaction: 3, usability: 1, quality: null });
    assert.deepEqual(result.lowestObstacleDimensions, ['imageBaseQuality']);
  });

  it('returns 0 immediately when any redline is present', () => {
    const result = scoreQualityAssessment(assessment({
      issueLabels: [{ severity: 'redline', label: '隐私泄露', evidence: '图片包含未处理的身份证件' }],
      dimensions: { queryRelevance: dimension(1) },
    }));

    assert.equal(result.finalScore, 0);
    assert.equal(result.action, 'redline_block');
    assert.equal(result.stoppedAt, 'redline');
    assert.deepEqual(result.lowestObstacleDimensions, ['issue:隐私泄露']);
  });

  it('uses a major issue label as a non-redline score-1 blocker', () => {
    const result = scoreQualityAssessment(assessment({
      issueLabels: [{ severity: 'major', label: '事实严重缺失', evidence: '攻略缺少关键步骤' }],
    }));

    assert.equal(result.finalScore, 1);
    assert.equal(result.action, 'return_for_revision');
    assert.equal(result.stoppedAt, 'issue');
  });

  it('applies type calibration only across the 2/3 boundary', () => {
    const promoted = scoreQualityAssessment(assessment({
      dimensions: { imageDiversity: dimension(2) },
      typeAdjustments: [{ dimension: 'imageDiversity', delta: 0.5, reason: '攻略类可适度放宽多样性' }],
    }));
    const notRescued = scoreQualityAssessment(assessment({
      dimensions: { informationValue: dimension(1) },
      typeAdjustments: [{ dimension: 'informationValue', delta: 0.5, reason: '尝试提升核心维度' }],
    }));
    const demoted = scoreQualityAssessment(assessment({
      typeAdjustments: [{ dimension: 'informationValue', delta: -0.5, reason: '攻略缺少可执行细节' }],
    }));

    assert.equal(promoted.finalScore, 3);
    assert.equal(promoted.dimensions.imageDiversity.score, 3);
    assert.equal(notRescued.finalScore, 1);
    assert.equal(notRescued.dimensions.informationValue.score, 1);
    assert.equal(demoted.finalScore, 2);
    assert.equal(demoted.dimensions.informationValue.score, 2);
  });

  it('returns insufficient evidence when a required dimension is missing', () => {
    const input = assessment();
    delete input.dimensions.imageAesthetics;

    const result = scoreQualityAssessment(input);

    assert.equal(result.finalScore, null);
    assert.equal(result.action, 'supplement_evidence');
    assert.equal(result.stoppedAt, 'evidence');
    assert.deepEqual(result.missingDimensions, ['imageAesthetics']);
  });

  it('allows platform adaptation to be not applicable when no platform is targeted', () => {
    const result = scoreQualityAssessment(assessment({
      targetPlatform: null,
      platformSampleEvidence: 'not_applicable',
      dimensions: {
        platformAdaptation: dimension(null, {
          evidence: ['未指定目标平台'],
          source: 'mechanical',
          applicable: false,
        }),
      },
    }));

    assert.equal(result.finalScore, 3);
    assert.equal(result.dimensions.platformAdaptation.applicable, false);
  });

  it('does not allow required non-platform dimensions to be marked not applicable', () => {
    assert.throws(
      () => scoreQualityAssessment(assessment({
        dimensions: {
          queryRelevance: dimension(null, {
            evidence: ['试图跳过 Query 相关性'],
            applicable: false,
          }),
        },
      })),
      /queryRelevance.*cannot be not applicable/i,
    );
  });

  it('rejects unknown dimensions, illegal scores and duplicate adjustments', () => {
    assert.throws(
      () => scoreQualityAssessment(assessment({ dimensions: { madeUpDimension: dimension(3) } })),
      /unknown dimension/i,
    );
    assert.throws(
      () => scoreQualityAssessment(assessment({ dimensions: { noteTone: dimension(2.5) } })),
      /score.*integer/i,
    );
    assert.throws(
      () => scoreQualityAssessment(assessment({
        typeAdjustments: [
          { dimension: 'noteTone', delta: 0.5, reason: 'first' },
          { dimension: 'noteTone', delta: -0.5, reason: 'second' },
        ],
      })),
      /duplicate adjustment/i,
    );
  });
});
