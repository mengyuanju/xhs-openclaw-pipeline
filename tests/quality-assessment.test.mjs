import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDeliveryQualityAssessmentPrompt,
  createDeliveryQualityAssessor,
  parseDeliveryQualityAssessmentOutput,
} from '../src/quality-assessment.mjs';

const DIMENSIONS = [
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

function modelAssessment(score = 3) {
  return {
    schemaVersion: 1,
    dimensions: Object.fromEntries(DIMENSIONS.map((name) => [name, {
      score,
      evidence: [`${name} 的可见证据`],
      applicable: true,
    }])),
    issueLabels: [],
    typeAdjustments: [],
  };
}

function deliveryFixture() {
  return {
    task: {
      query: '自行车铃铛被人弄坏了咋办',
      input: { referenceUrls: ['https://example.com/rules'] },
    },
    post: {
      title: '自行车铃铛被人弄坏了咋办？5步留证协商赔偿',
      body: '先拍照留证，再确认损坏范围，随后联系相关人员协商。'.repeat(10),
      sources: ['https://example.com/rules'],
      unverifiedClaims: [],
      riskFlags: [],
      platform: { target: '小红书', sampleEvidence: 'not_provided' },
    },
  };
}

describe('independent delivery quality assessment', () => {
  it('builds a bounded prompt from the final delivery contract', () => {
    const prompt = buildDeliveryQualityAssessmentPrompt({
      ...deliveryFixture(),
      imageCount: 4,
    });

    assert.match(prompt, /<untrusted_delivery_contract>/);
    assert.match(prompt, /自行车铃铛被人弄坏了咋办/);
    assert.match(prompt, /https:\/\/example\.com\/rules/);
    assert.match(prompt, /最低阻碍分/);
    assert.match(prompt, /任何可见错字.*不得给 3 分/u);
    assert.match(prompt, /inputReferenceText.*可用来源证据/u);
    assert.match(prompt, /不得额外要求图片展示网页截图/u);
    assert.match(prompt, /现名与原名/u);
    assert.match(prompt, /未提供站内正文和图集候选.*不参与最终评分/u);
    assert.match(prompt, /统一的色调、字体和装饰语言.*不得仅据此降低 imageDiversity/u);
    assert.match(prompt, /恰好 4 张图片/);
    assert.ok(prompt.length < 30_000);
  });

  it('keeps source facts but removes historical query-screening metadata from final review', () => {
    const fixture = deliveryFixture();
    fixture.task.input.referenceText = [
      '原始序号：15018',
      '原始判定：是否有效=否；废弃原因=规则13 游戏具体机制类',
      '判定说明：不具备通用内容价值',
      '事实摘要：游戏支持手动存档。',
    ].join('\n');

    const prompt = buildDeliveryQualityAssessmentPrompt({
      ...fixture,
      imageCount: 4,
    });

    assert.doesNotMatch(prompt, /规则13|是否有效=否|不具备通用内容价值/u);
    assert.match(prompt, /事实摘要：游戏支持手动存档/u);
    assert.match(prompt, /历史筛选、需求强度或导入判定不得作为成品质检依据/u);
  });

  it('normalizes every dimension to VLM evidence and rejects incomplete output', () => {
    const parsed = parseDeliveryQualityAssessmentOutput(JSON.stringify(modelAssessment()));

    assert.equal(parsed.dimensions.queryRelevance.score, 3);
    assert.equal(parsed.dimensions.queryRelevance.source, 'vlm');
    assert.throws(() => {
      const incomplete = modelAssessment();
      delete incomplete.dimensions.imageAesthetics;
      parseDeliveryQualityAssessmentOutput(JSON.stringify(incomplete));
    }, /missing dimension.*imageAesthetics/i);
  });

  it('keeps an issue label for manual review when the model leaves its evidence empty', () => {
    const output = modelAssessment();
    output.issueLabels = [{
      severity: 'minor',
      label: '局部排版仍需复核',
      evidence: '   ',
    }];

    const parsed = parseDeliveryQualityAssessmentOutput(JSON.stringify(output));

    assert.deepEqual(parsed.issueLabels, [{
      severity: 'minor',
      label: '局部排版仍需复核',
      evidence: '模型未提供独立证据；保留问题标签待人工复核：局部排版仍需复核',
    }]);
  });

  it('runs one final vision assessment across all delivery pages', async () => {
    const calls = [];
    const assessor = createDeliveryQualityAssessor({
      openclaw: {
        runVision(input) {
          calls.push(input);
          return { rawText: JSON.stringify(modelAssessment()), model: 'fake-quality-vlm' };
        },
      },
      ...deliveryFixture(),
      model: 'openai/quality-review-model',
    });

    const result = await assessor({
      imagePaths: ['01.png', '02.png', '03.png', '04.png'],
    });

    assert.equal(result.model, 'fake-quality-vlm');
    assert.equal(result.assessment.dimensions.informationValue.score, 3);
    assert.deepEqual(calls[0].inputPaths, ['01.png', '02.png', '03.png', '04.png']);
    assert.equal(calls[0].model, 'openai/quality-review-model');
  });

  it('retries one malformed final assessment with a bounded repair prompt', async () => {
    const calls = [];
    const assessor = createDeliveryQualityAssessor({
      openclaw: {
        runVision(input) {
          calls.push(input);
          return {
            rawText: JSON.stringify(calls.length === 1 ? { schemaVersion: 1, dimensions: {} } : modelAssessment()),
            model: 'fake-quality-vlm',
          };
        },
      },
      ...deliveryFixture(),
    });

    const result = await assessor({
      imagePaths: ['01.png', '02.png', '03.png', '04.png'],
    });

    assert.equal(result.assessment.dimensions.imageAesthetics.score, 3);
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /上一次终审输出未通过结构校验/u);
    assert.match(calls[1].prompt, /missing dimension/u);
  });

  it('stops after two malformed final assessments', async () => {
    let calls = 0;
    const assessor = createDeliveryQualityAssessor({
      openclaw: {
        runVision() {
          calls += 1;
          return { rawText: '{}', model: 'fake-quality-vlm' };
        },
      },
      ...deliveryFixture(),
    });

    await assert.rejects(
      () => assessor({ imagePaths: ['01.png', '02.png', '03.png'] }),
      /质量终审连续 2 次未通过结构校验/u,
    );
    assert.equal(calls, 2);
  });
});
