import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import sharp from 'sharp';

import { createMockPost, processNext } from '../src/pipeline.mjs';
import { createQueue } from '../src/queue.mjs';

const directories = [];
const queues = [];

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'xhs-pipeline-'));
  directories.push(directory);
  const queue = createQueue(join(directory, 'queue.sqlite'));
  queues.push(queue);
  return { directory, queue };
}

afterEach(async () => {
  while (queues.length > 0) queues.pop().close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('content pipeline', () => {
  it('moves one mock task from pending to a complete local delivery', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({
      query: '租房卧室的桌面总是乱，怎么做低成本整理？',
      input: { platform: 'xiaohongshu' },
    });

    const result = await processNext({
      queue,
      workerId: 'test-worker',
      outputRoot: join(directory, 'output'),
      mock: true,
    });

    assert.equal(result.status, 'completed', result.error);
    assert.equal(queue.get(task.id).status, 'completed');
    for (const file of [
      'post.json',
      'post.md',
      '01-hero.png',
      '02-steps.png',
      '03-checklist.png',
      'qc.json',
      'manifest.json',
    ]) {
      await access(join(result.outputDir, file));
    }

    const manifest = JSON.parse(await readFile(join(result.outputDir, 'manifest.json'), 'utf8'));
    const qc = JSON.parse(await readFile(join(result.outputDir, 'qc.json'), 'utf8'));
    assert.equal(manifest.mode, 'mock');
    assert.equal(manifest.taskId, task.id);
    assert.equal(manifest.images.length, 3);
    assert.equal(manifest.files.length, 6);
    assert.equal(qc.disposition, 'mock_only');
    assert.equal(qc.overallScore, 1);

    const metadata = await sharp(join(result.outputDir, '01-hero.png')).metadata();
    assert.deepEqual([metadata.width, metadata.height], [1080, 1440]);
  });

  it('marks a task failed when live text inference fails', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '一个真实调用失败的任务' });
    const openclaw = {
      runText() {
        throw new Error('OAuth unavailable with sk-abcdefghijklmnop');
      },
    };

    const result = await processNext({
      queue,
      workerId: 'test-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
    });

    assert.equal(result.status, 'failed');
    const failed = queue.get(task.id);
    assert.equal(failed.status, 'failed');
    assert.doesNotMatch(failed.error, /sk-abcdefghijklmnop/);
    assert.match(failed.error, /REDACTED/);
  });

  it('returns idle without writing files when the queue is empty', async () => {
    const { directory, queue } = await setup();

    const result = await processNext({
      queue,
      workerId: 'test-worker',
      outputRoot: join(directory, 'output'),
      mock: true,
    });

    assert.deepEqual(result, { status: 'idle' });
  });

  it('does not mark a live task completed when the quality gate blocks it', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({ query: '需要核验事实的桌面整理任务' });
    const post = createMockPost();
    post.unverifiedClaims = ['某个没有来源支持的量化结论'];
    const rawPng = await sharp({
      create: { width: 1024, height: 1536, channels: 3, background: '#d7c7b0' },
    }).png().toBuffer();
    const openclaw = {
      runText() {
        return { rawText: JSON.stringify(post), model: 'openai-codex/gpt-5.4-mini' };
      },
      runImage({ outputPath }) {
        writeFileSync(outputPath, rawPng);
        return { outputPath, model: 'openai/gpt-image-2' };
      },
    };

    const result = await processNext({
      queue,
      workerId: 'test-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
    });

    assert.equal(result.status, 'failed');
    assert.equal(queue.get(task.id).status, 'failed');
    assert.match(queue.get(task.id).error, /quality gate blocked/i);
  });

  it('passes pinned text, image count and reference files to live OpenClaw calls', async () => {
    const { directory, queue } = await setup();
    const task = queue.enqueue({
      query: '有参考图的玄关整理',
      input: { category: '收纳', targetAudience: '租房用户' },
    });
    const referencePath = join(directory, 'reference.png');
    await sharp({
      create: { width: 600, height: 800, channels: 3, background: '#d7c7b0' },
    }).png().toFile(referencePath);
    const rawPng = await sharp({
      create: { width: 1024, height: 1536, channels: 3, background: '#d7c7b0' },
    }).png().toBuffer();
    let textPrompt;
    let imagePrompt;
    const openclaw = {
      runText({ prompt }) {
        textPrompt = prompt;
        return { rawText: JSON.stringify(createMockPost()), model: 'fake-text' };
      },
      runImageEdit({ prompt, inputPaths, outputPath }) {
        imagePrompt = prompt;
        assert.deepEqual(inputPaths, [referencePath]);
        writeFileSync(outputPath, rawPng);
        return { outputPath, model: 'fake-image-edit' };
      },
    };

    const result = await processNext({
      queue,
      workerId: 'pinned-worker',
      outputRoot: join(directory, 'output'),
      mock: false,
      openclaw,
      configProvider: () => ({
        imageCount: 4,
        textPromptContent: '围绕 {{query}} 写给 {{targetAudience}}，分类 {{category}}。',
        imagePromptContent: '生成第 {{imageIndex}} 张，共 {{imageCount}} 张，主题 {{query}}。',
        referenceImagePaths: [referencePath],
      }),
    });

    assert.equal(result.status, 'completed', result.error);
    assert.match(textPrompt, /有参考图的玄关整理/);
    assert.match(textPrompt, /本任务最终交付 4 张图片/);
    assert.match(imagePrompt, /生成第 1 张，共 4 张/);
    const manifest = JSON.parse(await readFile(join(result.outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.images.length, 4);
    assert.equal(manifest.images[0].provider, 'openclaw-image-edit');
  });
});
