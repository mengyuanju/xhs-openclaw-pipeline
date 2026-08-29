import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import sharp from 'sharp';

import { processNext } from '../src/pipeline.mjs';
import { createQueue } from '../src/queue.mjs';
import { createMockVisualPlan } from '../src/visual-plan.mjs';

const directories = [];
const queues = [];

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
  'queryRelevance', 'contentOriginality', 'imageBaseQuality', 'imageTextQuality',
  'imageConsistency', 'noteTone', 'platformAdaptation', 'informationValue',
  'imageAesthetics', 'imageDiversity',
];

function passingQualityAssessment() {
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

afterEach(async () => {
  while (queues.length) queues.pop().close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function validPost() {
  return {
    taskJudgement: {
      admitted: true,
      demandLevel: 'strong',
      primaryType: '教程',
      reason: '用户需要可执行的整理步骤。',
    },
    platform: {
      target: '小红书',
      expressionType: '信息型',
      audience: '租房用户',
      openingMethod: '直接回应桌面反复变乱的问题',
      bodyStructure: '清空、分类、定位置、每日复位',
      iconDictionary: {},
      sampleEvidence: 'not_provided',
    },
    title: '桌面整理先做减法',
    body: '先把桌面上的物品全部移开，保留真正需要每天使用的东西。不要急着购买收纳盒，先观察纸笔、充电器和文件最常出现的位置。把高频用品放在伸手能够拿到的区域，低频用品移入抽屉，并给每一类物品设定固定位置。完成分区后，只留下当天会使用的物品。每天睡前检查垃圾是否离桌、物品是否归位、第二天用品是否已经准备好。如果某个区域总是再次变乱，说明位置并不符合动作习惯，应调整位置而不是增加新的容器。连续执行几天后，再判断是否需要补充收纳工具。选择工具时按照物品尺寸和使用频率决定，避免为了填满空间而购买。最后拍照记录整理后的基准状态，之后按照这个状态完成一分钟复位。',
    tags: ['#桌面整理', '#租房生活', '#收纳方法'],
    imagePlan: [
      { kind: 'hero', headline: '桌面整理先做减法', subtitle: '低成本保持清爽', bullets: ['先清空', '再分区', '最后复位'], prompt: '真实租房卧室桌面，暖色自然光，木质桌面，主体居中，无文字无水印。' },
      { kind: 'steps', headline: '四步整理顺序', subtitle: '先别买收纳盒', bullets: ['清空', '分类', '定位置', '复位'], prompt: '按正文顺序生成四步整理页面，仅展示给定步骤文字。' },
      { kind: 'checklist', headline: '睡前复位清单', subtitle: '只检查三件事', bullets: ['垃圾离桌', '物品归位', '准备明天用品'], prompt: '生成睡前复位检查页面，突出三个给定检查项。' },
    ],
    sources: [],
    expressionReferences: [],
    riskFlags: [],
    fabricatedExperience: false,
    unverifiedClaims: [],
  };
}

describe('visual knowledge pipeline integration', () => {
  it('combines the published visual recipe with global and task image instructions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-visual-pipeline-'));
    directories.push(directory);
    const queue = createQueue(join(directory, 'queue.db'));
    queues.push(queue);
    queue.enqueue({
      query: '低成本整理卧室桌面',
      input: { category: '收纳', targetAudience: '租房用户' },
    });
    const rawImages = await Promise.all(['#d8c7b4', '#c7d8b4', '#b4c7d8'].map((background) => sharp({
      create: { width: 1024, height: 1536, channels: 3, background },
    }).png().toBuffer()));
    const imageCalls = [];
    const textCalls = [];
    const openclaw = {
      runText({ prompt }) {
        textCalls.push(prompt);
        const post = validPost();
        return {
          rawText: JSON.stringify(
            prompt.includes('视觉规划步骤') ? createMockVisualPlan(post, { imageCount: 3 }) : post,
          ),
          model: 'fake-text',
        };
      },
      runImage({ prompt, outputPath }) {
        imageCalls.push({ method: 'generate', prompt, inputPaths: [] });
        writeFileSync(outputPath, rawImages[imageCalls.length - 1]);
        return { outputPath, model: 'fake-image' };
      },
      runImageEdit({ prompt, inputPaths, outputPath }) {
        imageCalls.push({ method: 'edit', prompt, inputPaths });
        writeFileSync(outputPath, rawImages[imageCalls.length - 1]);
        return { outputPath, model: 'fake-image' };
      },
      runVision({ prompt }) {
        return {
          rawText: JSON.stringify(
            prompt.includes('独立于生成模型的图文交付终审员')
              ? passingQualityAssessment()
              : passingAlignment(prompt),
          ),
          model: 'fake-vision',
        };
      },
    };

    const result = await processNext({
      queue,
      workerId: 'visual-worker',
      outputRoot: join(directory, 'output'),
      openclaw,
      configProvider: () => ({
        imageCount: 3,
        imagePromptContent: '保持 3:4 竖版构图，主题 {{query}}。',
        visualReference: {
          versionId: 7,
          type: 'PHOTO_HERO',
          promptTemplate: '使用 {{category}} 场景的暖色生活感构图。',
          negativePrompt: '不要水印和乱码。',
          layoutRules: {
            hero: '封面采用真实主体居中的摄影构图。',
            steps: '步骤页采用四段纵向流程。',
            checklist: '清单页采用三张勾选卡片。',
          },
        },
      }),
    });

    assert.equal(result.status, 'completed', result.error);
    assert.equal(textCalls.length, 2);
    assert.match(textCalls[1], /视觉规划步骤/);
    assert.equal(imageCalls.length, 3);
    for (const call of imageCalls) {
      assert.match(call.prompt, /保持 3:4 竖版构图/);
      assert.match(call.prompt, /使用 收纳 场景的暖色生活感构图/);
      assert.match(call.prompt, /不要水印和乱码/);
      assert.match(call.prompt, /先把桌面上的物品全部移开/);
      assert.match(call.prompt, /allowedVisibleText/);
      assert.match(call.prompt, /sourceEvidence/);
      assert.match(call.prompt, /zh-CN/);
      assert.match(call.prompt, /直接生成包含完整图文排版的最终页面/u);
      assert.match(call.prompt, /labels/);
      assert.match(call.prompt, /逐字渲染 allowedVisibleText/u);
      assert.doesNotMatch(call.prompt, /不得生成任何可见文字、字母、数字、伪文字/u);
      assert.match(call.prompt, /layoutTemplate 是唯一版式依据/u);
      assert.match(call.prompt, /主体区域：/u);
      assert.match(call.prompt, /文字排版区域：/u);
      assert.doesNotMatch(call.prompt, /画面上半部约 52%|下半部程序文字面板/);
      assert.match(call.prompt, /必须生成全新场景与构图/);
    }
    assert.match(imageCalls[0].prompt, /桌面整理先做减法/);
    assert.match(imageCalls[0].prompt, /真实主体居中/);
    assert.match(imageCalls[1].prompt, /四步整理顺序/);
    assert.match(imageCalls[1].prompt, /四段纵向流程/);
    assert.match(imageCalls[2].prompt, /睡前复位清单/);
    assert.match(imageCalls[2].prompt, /三张勾选卡片/);
    assert.ok(imageCalls[1].inputPaths.some((path) => path.endsWith('.style-reference.png')));
    assert.ok(imageCalls[2].inputPaths.some((path) => path.endsWith('.style-reference.png')));
  });
});
