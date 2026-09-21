import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_DISCLOSURE_TEXT,
  DISCLOSURE_HISTORY_STORAGE_KEY,
  addRecentDisclosureText,
  loadRecentDisclosureTexts,
  normalizeRecentDisclosureTexts,
  saveRecentDisclosureTexts,
} from '../src/recent-disclosure-texts.mjs';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

describe('recent artificial disclosure text', () => {
  it('uses the requested portrait disclosure by default', () => {
    assert.equal(DEFAULT_DISCLOSURE_TEXT, '该人物形象由AI生成');
  });

  it('keeps the five most recent unique valid values', () => {
    let history = ['第一条', '第二条', '第三条', '第四条', '第五条'];
    history = addRecentDisclosureText(history, '第六条');
    assert.deepEqual(history, ['第六条', '第一条', '第二条', '第三条', '第四条']);
    assert.deepEqual(addRecentDisclosureText(history, '第二条'), [
      '第二条', '第六条', '第一条', '第三条', '第四条',
    ]);
    assert.deepEqual(normalizeRecentDisclosureTexts([
      '  合规标识  ', '合规标识', '含 空格', '', null, 'AI生成',
    ]), ['合规标识', 'AI生成']);
  });

  it('loads and saves bounded history without breaking on invalid storage', () => {
    const storage = memoryStorage({ [DISCLOSURE_HISTORY_STORAGE_KEY]: '{bad json' });
    assert.deepEqual(loadRecentDisclosureTexts(storage), []);
    assert.deepEqual(saveRecentDisclosureTexts(storage, [
      '一', '二', '三', '四', '五', '六',
    ]), ['一', '二', '三', '四', '五']);
    assert.deepEqual(loadRecentDisclosureTexts(storage), ['一', '二', '三', '四', '五']);
  });
});
