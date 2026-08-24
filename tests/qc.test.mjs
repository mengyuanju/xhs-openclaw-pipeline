import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import sharp from 'sharp';

import { evaluateDelivery } from '../src/qc.mjs';

function post(overrides = {}) {
  return {
    title: '租房桌面整理方法',
    body: '先清空桌面，再按使用频率分类，最后给高频物品固定位置。'.repeat(10),
    fabricatedExperience: false,
    riskFlags: [],
    unverifiedClaims: [],
    expressionReferences: ['https://example.com/reference'],
    platform: { sampleEvidence: 'limited', iconDictionary: {} },
    ...overrides,
  };
}

async function writePng(path, color) {
  await sharp({ create: { width: 1080, height: 1440, channels: 3, background: color } })
    .png()
    .toFile(path);
}

describe('delivery quality checks', () => {
  it('treats the 400–600 character target as advisory rather than a hard failure', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'xhs-qc-'));
    try {
      const images = [
        { file: '01.png' },
        { file: '02.png' },
        { file: '03.png' },
      ];
      await Promise.all([
        writePng(join(outputDir, '01.png'), '#ff0000'),
        writePng(join(outputDir, '02.png'), '#00ff00'),
        writePng(join(outputDir, '03.png'), '#0000ff'),
      ]);

      const qc = await evaluateDelivery({
        post: post({ body: '先清空，再分类，最后复位。'.repeat(20) }),
        images,
        outputDir,
        mode: 'live',
      });

      const recommendedLength = qc.checks.find(({ id }) => id === 'body_recommended_length');
      assert.equal(recommendedLength.passed, false);
      assert.equal(recommendedLength.blocking, false);
      assert.equal(qc.disposition, 'manual_review_required');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('blocks forbidden title hooks and byte-identical delivery images', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'xhs-qc-'));
    try {
      const source = join(outputDir, '01.png');
      await writePng(source, '#ff0000');
      await sharp(source).toFile(join(outputDir, '02.png'));
      await writePng(join(outputDir, '03.png'), '#0000ff');
      const images = [{ file: '01.png' }, { file: '02.png' }, { file: '03.png' }];

      const qc = await evaluateDelivery({
        post: post({ title: '一篇看懂桌面整理' }),
        images,
        outputDir,
        mode: 'live',
      });

      assert.equal(qc.checks.find(({ id }) => id === 'title_quality').passed, false);
      assert.equal(qc.checks.find(({ id }) => id === 'duplicate_images').passed, false);
      assert.equal(qc.disposition, 'blocked');
      assert.ok(qc.issues.some(({ label }) => label === '内容-标题问题'));
      assert.ok(qc.issues.some(({ label }) => label === '配图-重复配图'));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
