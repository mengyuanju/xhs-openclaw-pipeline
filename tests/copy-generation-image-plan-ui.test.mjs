import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('standalone copy image-plan presentation', () => {
  it('shows every original and reviewed image-plan page with its complete planning fields', async () => {
    const comparison = await source('app/copy-generation/copy-generation-comparison.tsx');

    assert.match(comparison, /type CopyImagePlanPage/u);
    assert.match(comparison, /<CopyImagePlan/u);
    assert.match(comparison, /version\.imagePlan/u);
    assert.match(comparison, /图片策划/u);
    assert.match(comparison, /第\{index \+ 1\}页/u);
    assert.match(comparison, /page\.kind/u);
    assert.match(comparison, /page\.headline/u);
    assert.match(comparison, /page\.subtitle/u);
    assert.match(comparison, /page\.bullets\.map/u);
    assert.match(comparison, /page\.prompt/u);
    assert.match(comparison, /<ol className="copy-image-plan-list">/u);
    assert.match(comparison, /<details/u);
    assert.match(comparison, /<summary>查看画面提示<\/summary>/u);
  });

  it('uses responsive image-plan styles without turning each page into raw JSON', async () => {
    const [comparison, styles] = await Promise.all([
      source('app/copy-generation/copy-generation-comparison.tsx'),
      source('app/globals.css'),
    ]);

    assert.match(styles, /\.copy-image-plan-list/u);
    assert.match(styles, /\.copy-image-plan-page/u);
    assert.match(styles, /\.copy-image-plan-bullets/u);
    assert.doesNotMatch(comparison, /JSON\.stringify\(version\.imagePlan/u);
  });
});
