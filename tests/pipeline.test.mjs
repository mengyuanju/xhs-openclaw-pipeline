import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import sharp from 'sharp';

import { processNext } from '../src/pipeline.mjs';
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

    assert.equal(result.status, 'completed');
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
});
