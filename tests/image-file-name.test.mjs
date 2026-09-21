import assert from 'node:assert/strict';
import test from 'node:test';

import { orderedImageFileName } from '../src/image-file-name.mjs';

test('image file names always retain their logical page sequence', () => {
  assert.equal(orderedImageFileName('01-cover.png', 1), '01-cover.png');
  assert.equal(orderedImageFileName('source-03-comparison.png', 3), '03-comparison.png');
  assert.equal(orderedImageFileName('99-summary.webp', 4, 'image/webp'), '04-summary.webp');
  assert.equal(orderedImageFileName('02.png', 1), '01.png');
  assert.equal(orderedImageFileName(null, 5), '05-image.png');
});

test('generated edit UUID names become stable ordered names', () => {
  assert.equal(
    orderedImageFileName('delivery-e0227b68-1bbb-4b51-811a-bbef731b2732.png', 1),
    '01-edited.png',
  );
  assert.equal(orderedImageFileName('图片.png', 2), '02-图片.png');
});
