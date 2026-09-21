const GRAPHEME_SEGMENTER = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });

export function visibleCharacterCount(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  return [...GRAPHEME_SEGMENTER.segment(value)].length;
}
