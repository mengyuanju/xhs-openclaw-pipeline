import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { loadUploadedImages, saveCheckpoint } from '../src/executor/image-checkpoints.mjs';
import { standaloneImageRunDirectory } from '../src/standalone-image-generation.mjs';

test('recovery retains source and delivery uploads and rejects foreign file paths or invalid assets', async () => {
  const base = resolve(tmpdir());
  const taskRoot = await mkdtemp(join(base, 'xhs-upload-checkpoint-'));
  const runId = '11111111-1111-4111-8111-111111111111';
  try {
    const directory = standaloneImageRunDirectory(taskRoot, runId);
    await mkdir(directory, { recursive: true });
    const entry = id => ({ sha256: 'a'.repeat(64), asset: { id, url: `/v1/assets/${id}`, imageRunId: runId } });
    const valid = ['01-hero.png', 'source-01-hero.png', '01-hero.jpg', '02-steps.webp', '03-summary.avif', '04-details.gif'];
    await saveCheckpoint(join(directory, 'uploads.json'), Object.fromEntries([
      ...valid.map((file, index) => [file, entry(index + 1)]),
      ['../01-hero.png', entry(20)], ['source-01-hero.exe', entry(21)],
      ['05-details.png', { ...entry(22), sha256: 'invalid' }],
      ['06-details.png', { ...entry(23), asset: { id: 23, url: '/v1/assets/24' } }],
    ]));
    const result = await loadUploadedImages(taskRoot, [runId]);
    assert.deepEqual(Object.keys(result).sort(), valid.sort());
    assert.ok(Object.values(result).every(value => value.asset.imageRunId === runId));
  } finally {
    const child = relative(base, resolve(taskRoot));
    assert.ok(child && !child.startsWith('..') && !resolve(taskRoot).endsWith(base));
    await rm(taskRoot, { recursive: true, force: true });
  }
});
