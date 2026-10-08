const GRAPHEME_SEGMENTER = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
const LATIN_LETTER_GRAPHEME = /^[A-Za-z]\p{M}*$/u;

export function visibleCharacterCount(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  return [...GRAPHEME_SEGMENTER.segment(value)].length;
}

export function imagePlanBulletCount(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  let count = 0;
  let inLatinWord = false;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    const isLatinLetter = LATIN_LETTER_GRAPHEME.test(segment.normalize('NFD'));
    if (!isLatinLetter || !inLatinWord) count += 1;
    inLatinWord = isLatinLetter;
  }
  return count;
}
