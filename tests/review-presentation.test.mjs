import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildImageBatches,
  imageNeedsCrop,
  qualityDimensionRows,
  qualityReasons,
} from '../app/tasks/[id]/review-presentation.mjs';

test('image assets are grouped under their generation run and edited descendants follow the root', () => {
  const runs = [
    { id: 11, attempt: 1, createdAt: '2026-08-27T01:00:00.000Z' },
    { id: 12, attempt: 2, createdAt: '2026-08-27T02:00:00.000Z' },
  ];
  const assets = [
    { id: 1, kind: 'GENERATED', parentAssetId: null, sourceTextRevisionId: 4, visualPlanSha256: 'plan-a', createdAt: '2026-08-27T00:59:00.000Z' },
    { id: 2, kind: 'GENERATED', parentAssetId: null, sourceTextRevisionId: 5, visualPlanSha256: 'plan-b', createdAt: '2026-08-27T01:59:00.000Z' },
    { id: 3, kind: 'EDITED', parentAssetId: 2, sourceTextRevisionId: 5, visualPlanSha256: 'plan-b', createdAt: '2026-08-27T02:10:00.000Z' },
    { id: 4, kind: 'REFERENCE', parentAssetId: null, sourceTextRevisionId: null, visualPlanSha256: null, createdAt: '2026-08-27T02:20:00.000Z' },
  ];

  const batches = buildImageBatches({ runs, assets, currentTextRevisionId: 5 });

  assert.deepEqual(batches.map(({ kind, run }) => [kind, run?.attempt ?? null]), [
    ['generation', 2],
    ['generation', 1],
    ['reference', null],
  ]);
  assert.deepEqual(batches[0].assets.map(({ id }) => id), [2, 3]);
  assert.equal(batches[0].isCurrent, true);
  assert.equal(batches[1].isCurrent, false);
});

test('unmatched historical images remain visible in a labeled batch', () => {
  const batches = buildImageBatches({
    runs: [],
    currentTextRevisionId: 8,
    assets: [
      { id: 9, kind: 'GENERATED', parentAssetId: null, sourceTextRevisionId: 8, visualPlanSha256: 'legacy-plan', createdAt: '2026-08-27T00:00:00.000Z' },
    ],
  });

  assert.equal(batches.length, 1);
  assert.equal(batches[0].kind, 'historical');
  assert.equal(batches[0].assets[0].id, 9);
  assert.equal(batches[0].isCurrent, true);
});

test('score evidence is translated into plain-language reasons and dimension rows', () => {
  const run = {
    qcScore: 2,
    qcDetail: {
      rubric: {
        lowestObstacleDimensions: ['imageTextQuality', 'issue:平台表达适配-材料不足'],
        dimensions: {
          imageTextQuality: {
            score: 2,
            evidence: ['图中文字逐字一致，但完整语义质量仍需人工终审。'],
            source: 'hybrid',
            applicable: true,
          },
        },
        issueLabels: [
          { severity: 'minor', label: '平台表达适配-材料不足', evidence: '缺少同题平台样本。' },
        ],
      },
    },
  };

  assert.deepEqual(qualityReasons(run), [
    '图片文字质量：图中文字逐字一致，但完整语义质量仍需人工终审。',
    '平台表达适配-材料不足：缺少同题平台样本。',
  ]);
  assert.deepEqual(qualityDimensionRows(run), [
    {
      key: 'imageTextQuality',
      label: '图片文字质量',
      score: 2,
      evidence: ['图中文字逐字一致，但完整语义质量仍需人工终审。'],
    },
  ]);
});

test('historical runs explain missing evidence without exposing raw data', () => {
  assert.deepEqual(
    qualityReasons({ qcScore: 2, qcDisposition: 'manual_review_required', qcDetail: null }),
    ['该历史批次只保存了总分，未保存逐项评分证据；请结合图片和人工审核结果复核。'],
  );
  assert.deepEqual(
    qualityReasons({ qcScore: null, qcDisposition: null, error: '图片生成失败' }),
    ['运行失败：图片生成失败'],
  );
});

test('technical failures are summarized as bounded plain Chinese text', () => {
  assert.deepEqual(
    qualityReasons({ qcScore: null, error: 'openclaw requires Node >=24.15.0. PATH searched: C:\\very\\long\\path' }),
    ['运行失败：运行环境版本不兼容，请检查 Node.js 与 OpenClaw 配置。'],
  );
  assert.deepEqual(
    qualityReasons({ qcScore: null, error: '[security] blocked URL fetch targetOrigin=https://chatgpt.com reason=Blocked hostname' }),
    ['运行失败：模型网络请求被安全策略拦截，请检查网络与代理配置。'],
  );
  assert.deepEqual(
    qualityReasons({ qcScore: null, error: 'model output does not contain a valid JSON object' }),
    ['运行失败：模型返回格式不符合要求，未生成可用结果。'],
  );
});

test('crop is only offered when an image is not already 3:4', () => {
  assert.equal(imageNeedsCrop(1080, 1440), false);
  assert.equal(imageNeedsCrop(750, 1000), false);
  assert.equal(imageNeedsCrop(1200, 1200), true);
  assert.equal(imageNeedsCrop(undefined, 1200), false);
});
