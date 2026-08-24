import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import sharp from 'sharp';

import { processNext } from '../src/pipeline.mjs';
import { createQueue } from '../src/queue.mjs';

const directories = [];
const queues = [];

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
      { kind: 'steps', headline: '四步整理顺序', subtitle: '先别买收纳盒', bullets: ['清空', '分类', '定位置', '复位'], prompt: '' },
      { kind: 'checklist', headline: '睡前复位清单', subtitle: '只检查三件事', bullets: ['垃圾离桌', '物品归位', '准备明天用品'], prompt: '' },
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
    const rawPng = await sharp({
      create: { width: 1024, height: 1536, channels: 3, background: '#d8c7b4' },
    }).png().toBuffer();
    let imagePrompt = '';
    const openclaw = {
      runText() {
        return { rawText: JSON.stringify(validPost()), model: 'fake-text' };
      },
      runImage({ prompt, outputPath }) {
        imagePrompt = prompt;
        writeFileSync(outputPath, rawPng);
        return { outputPath, model: 'fake-image' };
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
        },
      }),
    });

    assert.equal(result.status, 'completed', result.error);
    assert.match(imagePrompt, /保持 3:4 竖版构图/);
    assert.match(imagePrompt, /使用 收纳 场景的暖色生活感构图/);
    assert.match(imagePrompt, /不要水印和乱码/);
    assert.match(imagePrompt, /真实租房卧室桌面/);
  });
});
