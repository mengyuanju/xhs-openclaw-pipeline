import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createImageAlignmentValidator,
  parseImageAlignmentOutput,
} from '../src/image-alignment.mjs';
import {
  businessPrompt,
  createPromptRuntime,
  promptProvenance,
  promptRuntimeSnapshot,
  withPromptRuntime,
} from '../src/prompt-runtime.mjs';

const ALLOWED_TEXT = {
  language: 'zh-CN',
  headline: '桌面整理：先清空',
  subtitle: '保留“常用” A4 纸',
  bullets: ['分开高频物品', '每天复位一次'],
  labels: ['工具'],
};

function modelOutput(overrides = {}) {
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
      headline: ALLOWED_TEXT.headline,
      subtitle: ALLOWED_TEXT.subtitle,
      bullets: [...ALLOWED_TEXT.bullets],
      otherText: [...ALLOWED_TEXT.labels],
    },
    unreadableText: [],
    hasTraditionalChinese: false,
    ocrConfidence: 0.99,
    failureClass: 'PASS',
    repairInstruction: '',
    ...overrides,
  };
}

function alignmentRuntime({ name = '严格验收', version = 1, settings = {} } = {}) {
  return createPromptRuntime({
    source: `TEST_${name}`,
    prompts: {
      IMAGE_ALIGNMENT_SYSTEM: { content: `${name}：逐字抄录图片文字，不补全或纠正。`, versionId: `${name}-${version}`, version },
    },
    settings,
  });
}

function parseUnderRuntime(output, runtime = alignmentRuntime()) {
  return withPromptRuntime(runtime, () => parseImageAlignmentOutput(JSON.stringify(output), {
    allowedVisibleText: ALLOWED_TEXT,
  }));
}

function parseAllowedUnderRuntime(output, allowedVisibleText, runtime = alignmentRuntime()) {
  return withPromptRuntime(runtime, () => parseImageAlignmentOutput(JSON.stringify(output), {
    allowedVisibleText,
  }));
}

function validatorFixture(agentClient) {
  return createImageAlignmentValidator({
    agentClient,
    post: { title: '桌面整理', body: '先清空桌面，分开高频物品，每天复位一次。' },
    visualPage: {
      index: 1,
      kind: 'hero',
      visualSubject: '桌面与文具',
      layoutDirection: '标题与文具分区呈现',
      sourceEvidence: ['先清空桌面'],
      allowedVisibleText: ALLOWED_TEXT,
      mustShow: ['画面：桌面与文具'],
      mustAvoid: ['额外文字'],
    },
    imageCount: 3,
    complianceDisclosure: '',
  });
}

describe('governed OCR comparison and isolated prompt execution', () => {
  it('accepts only CR/LF layout differences without changing recognized text', () => {
    const output = modelOutput();
    output.recognizedText.headline = '桌面整理：\r\n先清空';
    output.recognizedText.subtitle = '保留“常用” \nA4 纸';
    output.recognizedText.bullets[0] = '分开\r高频物品';
    output.recognizedText.otherText[0] = '工\n具';
    const result = parseUnderRuntime(output);

    assert.equal(result.ocrExactMatch, true);
    assert.equal(result.passed, true);
    assert.deepEqual(result.ocrMismatches, []);
    assert.deepEqual(result.recognizedText, output.recognizedText);
    assert.equal(result.programAssessment.comparison, 'LINE_BREAKS_ONLY');
  });

  it('rejects punctuation, quotation, spacing and full-width differences under strict comparison', async (t) => {
    const mutations = {
      punctuation(text) { text.headline = text.headline.replace('：', ':'); },
      omittedPunctuation(text) { text.headline = text.headline.replace('：', ''); },
      quotationStyle(text) { text.subtitle = text.subtitle.replace('“', '‘').replace('”', '’'); },
      internalSpace(text) { text.subtitle = text.subtitle.replace(' A4 ', 'A4'); },
      fullWidthLatin(text) { text.subtitle = text.subtitle.replace('A4', 'Ａ４'); },
      leadingSpace(text) { text.headline = ` ${text.headline}`; },
      trailingSpace(text) { text.headline = `${text.headline} `; },
      tabInsteadOfSpace(text) { text.subtitle = text.subtitle.replace(' ', '\t'); },
      nonBreakingSpace(text) { text.subtitle = text.subtitle.replace(' ', '\u00a0'); },
      bulletSpacing(text) { text.bullets[0] = '分开 高频物品'; },
      labelSpacing(text) { text.otherText[0] = ' 工具 '; },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      await t.test(name, () => {
        const output = modelOutput();
        mutate(output.recognizedText);
        const result = parseUnderRuntime(output);

        assert.equal(result.ocrExactMatch, false, `${name} is a real text difference`);
        assert.equal(result.passed, false);
        assert.equal(result.failureClass, 'OCR_MISMATCH');
        assert.ok(result.ocrMismatches.length > 0);
        assert.deepEqual(result.recognizedText, output.recognizedText, 'comparison must not silently normalize the OCR evidence');
      });
    }
  });

  it('accepts only the Unicode Celsius symbol and contiguous degree-plus-capital-C as equivalent', async (t) => {
    const allowedVisibleText = {
      language: 'zh-CN',
      headline: '冷藏不高于4℃',
      subtitle: '冷冻不高于－18℃',
      bullets: ['及时放回冰箱'],
      labels: [],
    };
    for (const failureClass of ['MINOR_TEXT', 'OCR_MISMATCH']) {
      await t.test(failureClass, () => {
        const output = modelOutput({
          textErrors: failureClass === 'MINOR_TEXT'
            ? ['温度单位写法不同：图片为“°C”，要求为“℃”']
            : ['图片文字为“冷藏不高于4°C”，allowedVisibleText要求“冷藏不高于4℃”，仅温度单位符号不同'],
          failureClass,
          repairInstruction: '将温度单位写法从 °C 改为 ℃',
        });
        output.recognizedText = {
          headline: '冷藏不高于4°C',
          subtitle: '冷冻不高于－18°C',
          bullets: ['及时放回冰箱'],
          otherText: [],
        };
        const result = parseAllowedUnderRuntime(output, allowedVisibleText);

        assert.equal(result.passed, true);
        assert.equal(result.failureClass, 'PASS');
        assert.deepEqual(result.textErrors, []);
        assert.deepEqual(result.ocrMismatches, []);
        assert.equal(result.modelAssessment.failureClass, failureClass);
        assert.equal(result.programAssessment.celsiusEquivalence.method,
          'U+2103_EQUIVALENT_TO_U+00B0_LATIN_CAPITAL_C');
        assert.equal(result.programAssessment.celsiusEquivalence.applied, true);
        assert.equal(result.programAssessment.celsiusEquivalence.applications.length, 2);
        assert.equal(result.programAssessment.celsiusEquivalence.normalizedModelRejection, true);
        assert.deepEqual(result.programAssessment.celsiusEquivalence.ignoredTextErrors, output.textErrors);
      });
    }
  });

  it('does not broaden Celsius equivalence to missing, lowercase, spaced, Fahrenheit or other characters', async (t) => {
    const allowedVisibleText = {
      language: 'zh-CN',
      headline: '冷藏4℃',
      subtitle: '冷冻－18℃',
      bullets: [],
      labels: [],
    };
    const cases = [
      ['missing-degree', '冷藏4C', '冷冻－18°C'],
      ['lowercase-c', '冷藏4°c', '冷冻－18°C'],
      ['space-before-c', '冷藏4° C', '冷冻－18°C'],
      ['fahrenheit', '冷藏4°F', '冷冻－18°C'],
      ['extra-punctuation', '冷藏4°C！', '冷冻－18°C'],
      ['minus-width', '冷藏4°C', '冷冻-18°C'],
    ];
    for (const [name, headline, subtitle] of cases) {
      await t.test(name, () => {
        const output = modelOutput();
        output.recognizedText = { headline, subtitle, bullets: [], otherText: [] };
        const result = parseAllowedUnderRuntime(output, allowedVisibleText);

        assert.equal(result.passed, false);
        assert.equal(result.failureClass, 'OCR_MISMATCH');
        assert.ok(result.ocrMismatches.length > 0);
      });
    }
  });

  it('keeps semantic and mixed-text model rejections even when a Celsius notation pair is present', () => {
    const allowedVisibleText = {
      language: 'zh-CN',
      headline: '冷藏4℃',
      subtitle: '当天食用',
      bullets: [],
      labels: [],
    };
    const recognizedText = { headline: '冷藏4°C', subtitle: '当天食用', bullets: [], otherText: [] };
    const semantic = parseAllowedUnderRuntime(modelOutput({
      recognizedText,
      failureClass: 'SEMANTIC',
      repairInstruction: '温度写法可接受，但画面语义与任务场景不符',
    }), allowedVisibleText);
    assert.equal(semantic.passed, false);
    assert.equal(semantic.failureClass, 'SEMANTIC');
    assert.equal(semantic.programAssessment.celsiusEquivalence.normalizedModelRejection, false);

    const mixed = parseAllowedUnderRuntime(modelOutput({
      recognizedText,
      textErrors: [
        '温度单位写法不同：°C 与 ℃',
        '副标题缺少关键文字',
      ],
      failureClass: 'MINOR_TEXT',
      repairInstruction: '修正 °C 与 ℃ 并补齐缺少的文字',
    }), allowedVisibleText);
    assert.equal(mixed.passed, false);
    assert.equal(mixed.failureClass, 'MINOR_TEXT');
    assert.deepEqual(mixed.textErrors, ['副标题缺少关键文字']);
    assert.equal(mixed.programAssessment.celsiusEquivalence.normalizedModelRejection, false);

    for (const textError of [
      '温度单位写法不同：图片为“°C”，要求为“℃”，同时人物有六根手指',
      '图片文字为“冷藏4°C”，allowedVisibleText要求“冷藏4℃”，仅温度单位符号不同，同时人物有六根手指',
      '图片为5°C，要求为4℃，温度单位写法不同',
      '将°C与℃从标题中改为副标题中',
    ]) {
      const rejected = parseAllowedUnderRuntime(modelOutput({
        recognizedText,
        textErrors: [textError],
        failureClass: 'MINOR_TEXT',
        repairInstruction: '将温度单位写法从 °C 改为 ℃',
      }), allowedVisibleText);
      assert.equal(rejected.passed, false, textError);
      assert.deepEqual(rejected.textErrors, [textError]);
      assert.equal(rejected.programAssessment.celsiusEquivalence.normalizedModelRejection, false);
    }

    const crossFieldInstruction = '将°C与℃从标题中改为副标题中';
    const crossField = parseAllowedUnderRuntime(modelOutput({
      recognizedText,
      textErrors: [crossFieldInstruction],
      failureClass: 'MINOR_TEXT',
      repairInstruction: crossFieldInstruction,
    }), allowedVisibleText);
    assert.equal(crossField.passed, false);
    assert.deepEqual(crossField.textErrors, [crossFieldInstruction]);
    assert.equal(crossField.programAssessment.celsiusEquivalence.normalizedModelRejection, false);
  });

  it('records Celsius matches with item indices for bullet and other-text audits', () => {
    const allowedVisibleText = {
      language: 'zh-CN',
      headline: '冰箱温度',
      subtitle: '分区存放',
      bullets: ['冷藏4℃', '冷冻－18℃'],
      labels: ['环境4℃'],
    };
    const output = modelOutput({
      recognizedText: {
        headline: '冰箱温度',
        subtitle: '分区存放',
        bullets: ['冷冻－18°C', '冷藏4°C'],
        otherText: ['环境4°C'],
      },
    });
    const result = parseAllowedUnderRuntime(output, allowedVisibleText);

    assert.equal(result.passed, true);
    assert.deepEqual(result.programAssessment.celsiusEquivalence.applications.map(({ field, index }) =>
      ({ field, index })), [
      { field: 'bullets', index: 0 },
      { field: 'bullets', index: 1 },
      { field: 'otherText', index: 0 },
    ]);
  });

  it('treats bullet OCR order as auditable geometry while retaining strict text identity', () => {
    const reordered = modelOutput();
    reordered.recognizedText.bullets.reverse();
    const accepted = parseUnderRuntime(reordered);

    assert.equal(accepted.passed, true);
    assert.equal(accepted.programAssessment.bulletComparison.passed, true);
    assert.equal(accepted.programAssessment.bulletComparison.orderMatched, false);
    assert.deepEqual(accepted.programAssessment.bulletComparison.recognizedOrder, [...ALLOWED_TEXT.bullets].reverse());
    assert.deepEqual(accepted.programAssessment.bulletComparison.allowedOrder, ALLOWED_TEXT.bullets);

    const altered = modelOutput();
    altered.recognizedText.bullets = ['每天复位一次', '分开 高频物品'];
    const rejected = parseUnderRuntime(altered);
    assert.equal(rejected.passed, false);
    assert.equal(rejected.failureClass, 'OCR_MISMATCH');
    assert.deepEqual(rejected.ocrMismatches, ['bullets']);

    const layoutRejected = modelOutput({
      layoutMatched: false,
      failureClass: 'STYLE_LAYOUT',
      repairInstruction: '文字内容齐全，但画面箭头表达的逻辑顺序错误',
    });
    layoutRejected.recognizedText.bullets.reverse();
    const rejectedByLayout = parseUnderRuntime(layoutRejected);
    assert.equal(rejectedByLayout.programAssessment.bulletComparison.passed, true);
    assert.equal(rejectedByLayout.programAssessment.bulletComparison.orderMatched, false);
    assert.equal(rejectedByLayout.passed, false);
    assert.equal(rejectedByLayout.failureClass, 'STYLE_LAYOUT');
  });

  it('keeps the complete model assessment alongside a separately explained program rejection', () => {
    const output = modelOutput();
    output.recognizedText.headline = '桌面整理：先分类';
    const result = parseUnderRuntime(output);

    assert.deepEqual(result.modelAssessment, output);
    assert.equal(result.modelAssessment.failureClass, 'PASS');
    assert.equal(result.modelAssessment.repairInstruction, '');
    assert.equal(result.passed, false);
    assert.equal(result.failureClass, 'OCR_MISMATCH');
    assert.equal(result.programAssessment.passed, false);
    assert.equal(result.programAssessment.failureClass, 'OCR_MISMATCH');
    assert.equal(result.programAssessment.ocrExactMatch, false);
    assert.deepEqual(result.programAssessment.ocrMismatches, ['headline']);
    assert.equal(result.programAssessment.comparison, 'LINE_BREAKS_ONLY');
    assert.equal(result.programAssessment.minimumConfidence, 0.9);
  });

  it('does not silently pass a model rejection even when all mechanical checks match', () => {
    const output = modelOutput({ failureClass: 'SEMANTIC', repairInstruction: '人工规则要求的信息关系未充分呈现，需要核实。' });
    const result = parseUnderRuntime(output);

    assert.equal(result.ocrExactMatch, true);
    assert.equal(result.passed, false);
    assert.equal(result.failureClass, 'SEMANTIC');
    assert.deepEqual(result.modelAssessment, output);
    assert.equal(result.programAssessment.passed, false);
  });

  it('uses the configured OCR confidence threshold and records it with the program result', () => {
    const output = modelOutput({ ocrConfidence: 0.94 });
    const result = parseUnderRuntime(output, alignmentRuntime({ settings: { ocrMinimumConfidence: 0.95 } }));

    assert.equal(result.passed, false);
    assert.equal(result.failureClass, 'OCR_UNCERTAIN');
    assert.deepEqual(result.ocrMismatches, ['confidence']);
    assert.equal(result.programAssessment.minimumConfidence, 0.95);
    assert.equal(result.modelAssessment.ocrConfidence, 0.94);
  });

  it('only exempts clearly incidental background unreadable text under governed OCR rules', () => {
    const incidental = modelOutput({
      unreadableText: ['背景书架书脊上的微小装饰字无法辨认'],
    });
    const accepted = parseUnderRuntime(incidental);
    assert.equal(accepted.passed, true);
    assert.deepEqual(accepted.programAssessment.ignoredUnreadableText, incidental.unreadableText);

    const required = parseUnderRuntime(modelOutput({
      unreadableText: ['标签“工具”中的文字无法辨认'],
    }));
    assert.equal(required.passed, false);
    assert.equal(required.failureClass, 'OCR_UNCERTAIN');
    assert.deepEqual(required.programAssessment.ignoredUnreadableText, []);

    for (const unreadable of [
      '屏幕上的文字无法辨认',
      '设备上的显眼大字无法辨认',
      '墙面中央的大段文字不可读',
      '背景书脊微小字不可读，同时人物有六根手指',
      '背景书脊微小字不可读，另有大面积乱码',
      '背景海报二维码与品牌水印不可读',
    ]) {
      const rejected = parseUnderRuntime(modelOutput({ unreadableText: [unreadable] }));
      assert.equal(rejected.passed, false, unreadable);
      assert.deepEqual(rejected.programAssessment.ignoredUnreadableText, []);
    }
  });

  it('isolates concurrent published rules, OCR policies and provenance across awaited vision calls', async () => {
    const initialContext = promptRuntimeSnapshot();
    let entered = 0;
    let release;
    const bothEntered = new Promise((resolve) => { release = resolve; });
    const calls = [];
    const fakeClient = {
      async runVision(input) {
        calls.push(input);
        entered += 1;
        if (entered === 2) release();
        await bothEntered;
        await Promise.resolve();
        const output = modelOutput({ ocrConfidence: 0.94 });
        output.recognizedText.headline = '桌面 整理：先清空';
        return { rawText: JSON.stringify(output), model: 'fake-concurrent-vision' };
      },
    };
    const strictRuntime = alignmentRuntime({ name: '严格任务甲', version: 7, settings: { ocrMinimumConfidence: 0.97 } });
    const legacyRuntime = alignmentRuntime({ name: '兼容任务乙', version: 3,
      settings: { ocrComparison: 'LEGACY_NORMALIZED', ocrMinimumConfidence: 0.9 } });
    const execute = (runtime) => withPromptRuntime(runtime, async () => {
      const result = await validatorFixture(fakeClient)({ imagePath: 'fake-image.png', pageIndex: 1, attempt: 1 });
      return { result, provenance: promptProvenance(), snapshot: promptRuntimeSnapshot() };
    });
    const [strict, legacy] = await Promise.all([execute(strictRuntime), execute(legacyRuntime)]);

    assert.equal(calls.length, 2);
    assert.equal(strict.result.passed, false);
    assert.deepEqual(strict.result.ocrMismatches, ['headline', 'confidence']);
    assert.equal(strict.result.programAssessment.comparison, 'LINE_BREAKS_ONLY');
    assert.equal(strict.result.programAssessment.minimumConfidence, 0.97);
    assert.equal(legacy.result.passed, true);
    assert.deepEqual(legacy.result.ocrMismatches, []);
    assert.equal(legacy.result.programAssessment.comparison, 'LEGACY_NORMALIZED');
    assert.equal(legacy.result.programAssessment.minimumConfidence, 0.9);
    for (const [record, runtime, ownName, otherName] of [
      [strict, strictRuntime, '严格任务甲', '兼容任务乙'],
      [legacy, legacyRuntime, '兼容任务乙', '严格任务甲'],
    ]) {
      assert.equal(record.snapshot.source, runtime.source);
      assert.deepEqual(record.snapshot.settings, runtime.settings);
      assert.equal(record.provenance.versions.length, 1);
      assert.equal(record.provenance.versions[0].versionId, runtime.prompts.IMAGE_ALIGNMENT_SYSTEM.versionId);
      const prompt = calls.find((input) => input.prompt.includes(ownName))?.prompt;
      assert.ok(prompt, 'each call must use its own published rule content');
      assert.ok(!prompt.includes(otherName));
    }
    assert.equal(promptRuntimeSnapshot(), initialContext, 'the completed executions must not leak an active context');
  });

  it('fails before a model call when the required published alignment rule is missing', async () => {
    let calls = 0;
    const validator = validatorFixture({
      async runVision() { calls += 1; return { rawText: JSON.stringify(modelOutput()), model: 'fake' }; },
    });
    await assert.rejects(withPromptRuntime(createPromptRuntime(), () => validator({
      imagePath: 'fake-image.png', pageIndex: 1, attempt: 1,
    })), /缺少已发布提示词 IMAGE_ALIGNMENT_SYSTEM/u);
    assert.equal(calls, 0, 'missing published rules must not silently use bundled defaults');
  });

  it('fails explicitly when a required inherited published rule is missing', () => {
    assert.throws(() => withPromptRuntime(alignmentRuntime(), () => businessPrompt('IMAGE_ALIGNMENT_SYSTEM', {
      inherits: ['TEXT_SYSTEM'],
    })), /缺少已发布提示词 TEXT_SYSTEM/u);
  });
});
