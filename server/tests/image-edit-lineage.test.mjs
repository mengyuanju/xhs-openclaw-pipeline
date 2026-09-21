import assert from 'node:assert/strict';
import test from 'node:test';
import { imagePageDisclosure, imageResultScopedToPage, imageSettingsScopedToPage } from '../src/image-edit-lineage.mjs';
import { disclosureRemovalConfig, requestsDisclosureRemoval } from '../src/image-edit-disclosure.mjs';

const firstPageDisclosure = { type: 'AI_GENERATED', text: '该人物形象由AI生成' };
const result = {
  images: [
    { imageEditRequiredText: ['第一页标题', '该人物形象由AI生成'] },
    { imageEditRequiredText: ['第二页标题'] },
    { imageEditRequiredText: null },
  ],
  imageEditValidation: { disclosure: { added: firstPageDisclosure, required: firstPageDisclosure.text } },
};

test('legacy run-level disclosure applies only to the page whose required text contains it', () => {
  assert.deepEqual(imagePageDisclosure(result, 1), firstPageDisclosure);
  assert.equal(imagePageDisclosure(result, 2), null);
  assert.equal(imagePageDisclosure(result, 3), null);
  assert.equal(imageResultScopedToPage(result, 3).imageEditValidation.disclosure.added, null);
  assert.deepEqual(result.imageEditValidation.disclosure.added, firstPageDisclosure,
    'page scoping must not mutate the stored run result');
});

test('explicit page disclosure wins after later edits change the run-level validation', () => {
  const explicit = { type: 'AI_GENERATED', text: 'AI生成' };
  const updated = { ...result, images: [result.images[0], { ...result.images[1], imageEditDisclosure: explicit }] };
  assert.deepEqual(imagePageDisclosure(updated, 2), explicit);
});

test('legacy executor settings disable disclosure inference only for an unlabelled page', () => {
  const settings = { aiDisclosureEnabled: true, aiDisclosureText: 'AI生成', modelApi: { provider: 'codex' } };
  assert.equal(imageSettingsScopedToPage(settings, result, 1), settings);
  assert.deepEqual(imageSettingsScopedToPage(settings, result, 2), {
    ...settings,
    aiDisclosureEnabled: false,
  });
});

test('intentional disclosure removal is explicit and negation-safe', () => {
  assert.equal(requestsDisclosureRemoval('去掉右下角的ai标识', firstPageDisclosure.text), true);
  assert.equal(requestsDisclosureRemoval('不要去掉右下角的AI标识', firstPageDisclosure.text), false);
  assert.equal(requestsDisclosureRemoval('去掉右下角的杯子', firstPageDisclosure.text), false);
  const config = disclosureRemovalConfig({ preserve: '保留人工生成标识', negative: '不得删除已有文字' });
  assert.match(config.preserve, /除说明明确点名的人工生成标识外/u);
  assert.match(config.negative, /被点名人工生成标识以外/u);
});
