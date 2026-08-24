import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import sharp from 'sharp';

import { renderDeliveryImages } from '../src/images.mjs';

const directories = [];

async function makeDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'xhs-images-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function postFixture(imageCount = 3) {
  const imagePlan = [
    {
      kind: 'hero',
      headline: '桌面整理先做减法',
      subtitle: '低成本也能保持清爽',
      bullets: ['先清空', '再分区', '最后复位'],
      prompt: '真实租房卧室桌面，暖色自然光，展示给定标题和要点。',
    },
    {
      kind: 'steps',
      headline: '四步整理顺序',
      subtitle: '别从买收纳盒开始',
      bullets: ['清空桌面', '按频率分类', '给高频物品定位置', '设置复位区'],
      prompt: '呈现四步整理过程，严格使用给定步骤文字，保持暖色生活感。',
    },
    {
      kind: 'checklist',
      headline: '每天一分钟复位',
      subtitle: '睡前检查这三件事',
      bullets: ['垃圾离桌', '物品归位', '明天用品预留'],
      prompt: '呈现睡前复位检查场景，突出三个给定检查项，不新增内容。',
    },
    {
      kind: 'comparison',
      headline: '整理前后差在哪',
      subtitle: '位置比容器更重要',
      bullets: ['高频物品伸手可取', '低频物品移入抽屉'],
      prompt: '生成整理前后对比页，突出高频和低频物品的位置差异。',
    },
    {
      kind: 'summary',
      headline: '一张图记住复位法',
      subtitle: '每天照着做即可',
      bullets: ['清垃圾', '放回原位', '预留明日用品'],
      prompt: '生成整篇方法总结页，用三个给定动作形成清晰信息层级。',
    },
  ].slice(0, imageCount);
  return {
    title: '租房桌面整理，先别急着买收纳盒',
    imagePlan,
  };
}

describe('delivery images', () => {
  it('renders three 1080x1440 PNG files in mock mode', async () => {
    const directory = await makeDirectory();

    const images = await renderDeliveryImages({
      post: postFixture(),
      outputDir: directory,
      mock: true,
    });

    assert.deepEqual(images.map((image) => image.file), [
      '01-hero.png',
      '02-steps.png',
      '03-checklist.png',
    ]);
    for (const image of images) {
      const metadata = await sharp(join(directory, image.file)).metadata();
      assert.equal(metadata.format, 'png');
      assert.equal(metadata.width, 1080);
      assert.equal(metadata.height, 1440);
    }
    assert.ok(images.every((image) => image.provider === 'mock'));
  });

  it('escapes model text before rendering SVG-backed cards', async () => {
    const directory = await makeDirectory();
    const post = postFixture();
    post.imagePlan[1].headline = '<image href="file:///secret">';

    await renderDeliveryImages({ post, outputDir: directory, mock: true });

    const png = await readFile(join(directory, '02-steps.png'));
    assert.ok(png.length > 1_000);
  });

  it('calls the image model for every live delivery image and uses the first image as later style reference', async () => {
    const directory = await makeDirectory();
    const rawImages = await Promise.all(['#d7c7b0', '#c7d7b0', '#b0c7d7'].map((background) => sharp({
      create: { width: 1024, height: 1536, channels: 3, background },
    }).png().toBuffer()));
    const calls = [];
    const openclaw = {
      runImage({ prompt, outputPath }) {
        calls.push({ method: 'generate', prompt, inputPaths: [] });
        writeFileSync(outputPath, rawImages[calls.length - 1]);
        return { outputPath, model: 'openai/gpt-image-2' };
      },
      runImageEdit({ prompt, inputPaths, outputPath }) {
        calls.push({ method: 'edit', prompt, inputPaths });
        writeFileSync(outputPath, rawImages[calls.length - 1]);
        return { outputPath, model: 'openai/gpt-image-2' };
      },
    };
    const imagePrompts = [
      '第一页完整模型图片生成提示词',
      '第二页完整模型图片生成提示词',
      '第三页完整模型图片生成提示词',
    ];

    const images = await renderDeliveryImages({
      post: postFixture(),
      outputDir: directory,
      mock: false,
      openclaw,
      imagePrompts,
    });

    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(({ prompt }) => prompt), imagePrompts);
    assert.deepEqual(calls.map(({ method }) => method), ['generate', 'edit', 'edit']);
    for (const call of calls.slice(1)) {
      assert.ok(call.inputPaths.includes(join(directory, '01-hero.png')));
    }
    assert.ok(images.every((image) => image.model === 'openai/gpt-image-2'));
    assert.ok(images.every((image) => image.provider !== 'local-template'));
    for (const image of images) {
      const metadata = await sharp(join(directory, image.file)).metadata();
      assert.deepEqual([metadata.width, metadata.height], [1080, 1440]);
    }
  });

  it('requires an explicit plan for every requested delivery image', async () => {
    const directory = await makeDirectory();

    await assert.rejects(
      () => renderDeliveryImages({
        post: postFixture(3),
        outputDir: directory,
        mock: true,
        imageCount: 5,
      }),
      /imagePlan.*5/i,
    );
  });

  it('renders five explicitly planned mock delivery images without local template providers', async () => {
    const directory = await makeDirectory();
    const images = await renderDeliveryImages({
      post: postFixture(5),
      outputDir: directory,
      mock: true,
      imageCount: 5,
    });

    assert.deepEqual(images.map((image) => image.file), [
      '01-hero.png',
      '02-steps.png',
      '03-checklist.png',
      '04-comparison.png',
      '05-summary.png',
    ]);
    assert.ok(images.every((image) => image.provider === 'mock'));
  });
});
