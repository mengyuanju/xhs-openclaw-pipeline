import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEditReferenceQuota, assertReferenceQuota } from '../src/image-editing.mjs';

const MiB = 1024 * 1024;

test('one edit permits exactly 40 MiB and 32 million reference pixels', () => {
  assert.doesNotThrow(() => assertEditReferenceQuota({ bytes: 40 * MiB, pixels: 32_000_000 }));
  assert.throws(() => assertEditReferenceQuota({ bytes: 40 * MiB + 1, pixels: 32_000_000 }),
    /参考图总大小或像素超限/u);
  assert.throws(() => assertEditReferenceQuota({ bytes: 40 * MiB, pixels: 32_000_001 }),
    /参考图总大小或像素超限/u);
});

test('reference storage permits exactly 100 MiB across at most 20 distinct normalized images', () => {
  assert.doesNotThrow(() => assertReferenceQuota({ count: 19, bytes: 100 * MiB - 1 }, 1));
  assert.throws(() => assertReferenceQuota({ count: 19, bytes: 100 * MiB - 1 }, 2),
    /任务参考图存储已达上限/u);
  assert.throws(() => assertReferenceQuota({ count: 20, bytes: 0 }, 1),
    /任务参考图存储已达上限/u);
  assert.doesNotThrow(() => assertReferenceQuota({ count: 8, bytes: 11 * MiB }, 5 * MiB));
  assert.doesNotThrow(() => assertReferenceQuota({ count: 1, bytes: 50 * MiB }, 1));
});
