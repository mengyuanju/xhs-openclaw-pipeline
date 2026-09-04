import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeCopyReviewEdits,
  normalizeCreateTask,
  normalizeNodeId,
  normalizeProgress,
  redactExecutionError,
} from '../src/domain.mjs';

const validReviewEdits = () => ({
  copy: {
    title: '租房桌面整理，低成本分区收纳',
    body: '先清空桌面并筛掉不需要长期留在手边的物品，再按照每天使用、偶尔使用和低频存放划分位置。'.repeat(10),
    tags: ['#桌面整理', '#低成本收纳', '#租房改造'],
  },
  imagePlan: [
    { kind: 'hero', headline: '桌面整理总览', subtitle: '清空、分区、向上收纳', bullets: ['先清空筛选', '再固定位置'], prompt: '明亮租房桌面的整理前后对比场景' },
    { kind: 'steps', headline: '清空并筛选', subtitle: '按使用频率分为三类', bullets: ['每天使用', '偶尔使用'], prompt: '桌面物品按照使用频率分区的俯拍场景' },
    { kind: 'summary', headline: '每日及时归位', subtitle: '保持桌面长期清爽', bullets: ['用完就放回', '每周重新筛选'], prompt: '整洁桌面与明确收纳区域的真实生活场景' },
  ],
});

test('control plane normalizes an executor-owned copy task', () => {
  assert.deepEqual(normalizeCreateTask({
    query: '  租房桌面整理  ',
    input: { category: '家居' },
    imageCount: 4,
  }), {
    query: '租房桌面整理',
    input: { category: '家居' },
    imageCount: 4,
  });
  assert.equal(normalizeNodeId('desktop-a:copy'), 'desktop-a:copy');
});

test('control plane rejects unsafe node identifiers and invalid image counts', () => {
  assert.throws(() => normalizeNodeId('../../server'), /nodeId/u);
  assert.throws(() => normalizeCreateTask({ query: '选题', imageCount: 9 }), /imageCount/u);
});

test('execution progress is bounded and secrets are redacted', () => {
  assert.deepEqual(normalizeProgress({
    stage: 'image_alignment',
    progressPercent: 47,
    message: '第 2 页',
    details: { page: 2 },
  }), {
    stage: 'IMAGE_ALIGNMENT',
    progressPercent: 47,
    message: '第 2 页',
    details: { page: 2 },
  });
  assert.equal(
    redactExecutionError('Bearer abcdefghijklmnop and sk-abcdefghijklmnop'),
    'Bearer [REDACTED_TOKEN] and [REDACTED_API_KEY]',
  );
});

test('copy review edits normalize editable copy and structured image-plan cards', () => {
  const normalized = normalizeCopyReviewEdits(validReviewEdits());
  assert.equal(normalized.copy.tags.length, 3);
  assert.equal(normalized.imagePlan[0].kind, 'hero');
  assert.equal(normalized.imagePlan.length, 3);
  assert.throws(() => normalizeCopyReviewEdits({
    ...validReviewEdits(),
    imagePlan: validReviewEdits().imagePlan.map((item, index) => ({
      ...item,
      kind: index === 0 ? 'steps' : item.kind,
    })),
  }), /hero/u);
});
