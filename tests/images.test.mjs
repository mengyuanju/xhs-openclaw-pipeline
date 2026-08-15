import assert from 'node:assert/strict';
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

function postFixture() {
  return {
    title: '租房桌面整理，先别急着买收纳盒',
    imagePlan: [
      {
        kind: 'hero',
        headline: '桌面整理先做减法',
        subtitle: '低成本也能保持清爽',
        bullets: ['先清空', '再分区', '最后复位'],
        prompt: '真实租房卧室桌面，暖色自然光，无人物，无文字，无Logo。',
      },
      {
        kind: 'steps',
        headline: '四步整理顺序',
        subtitle: '别从买收纳盒开始',
        bullets: ['清空桌面', '按频率分类', '给高频物品定位置', '设置复位区'],
        prompt: '',
      },
      {
        kind: 'checklist',
        headline: '每天一分钟复位',
        subtitle: '睡前检查这三件事',
        bullets: ['垃圾离桌', '物品归位', '明天用品预留'],
        prompt: '',
      },
    ],
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
    assert.equal(images[0].provider, 'mock');
    assert.equal(images[1].provider, 'local-template');
  });

  it('escapes model text before rendering SVG-backed cards', async () => {
    const directory = await makeDirectory();
    const post = postFixture();
    post.imagePlan[1].headline = '<image href="file:///secret">';

    await renderDeliveryImages({ post, outputDir: directory, mock: true });

    const png = await readFile(join(directory, '02-steps.png'));
    assert.ok(png.length > 1_000);
  });

  it('normalizes a live hero image to 3:4 and records the model', async () => {
    const directory = await makeDirectory();
    const rawHero = join(directory, 'raw-from-openclaw.png');
    await sharp({
      create: { width: 1024, height: 1536, channels: 3, background: '#d7c7b0' },
    }).png().toFile(rawHero);
    const openclaw = {
      runImage({ outputPath }) {
        assert.equal(outputPath, rawHero);
        return { outputPath, model: 'openai/gpt-image-2' };
      },
    };

    const images = await renderDeliveryImages({
      post: postFixture(),
      outputDir: directory,
      mock: false,
      openclaw,
      rawHeroPath: rawHero,
    });

    const metadata = await sharp(join(directory, '01-hero.png')).metadata();
    assert.equal(metadata.width, 1080);
    assert.equal(metadata.height, 1440);
    assert.equal(images[0].provider, 'openclaw');
    assert.equal(images[0].model, 'openai/gpt-image-2');
  });
});
