const CHINESE_DIGITS = '零一二三四五六七八九';
const ARABIC_NUMBER = /\d+(?:\.\d+)?(?:[千万亿])?%?/gu;

function normalizeNumericText(text) {
  return String(text).replace(/[０-９．％（）]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replaceAll('两', '二').replaceAll('〇', '零');
}

function withoutListMarkers(text) {
  // Only explicit line-leading list syntax; never strip a decimal or a quantity such as “5分钟”.
  return text.replace(/^[\t ]*(?:\d+[、)]|\d+\.(?!\d)|\(\d+\))[\t ]*/gmu, '');
}

function chineseInteger(value) {
  if (!Number.isSafeInteger(value)) return null;
  if (value === 0) return '零';
  for (const [unit, size] of [['亿', 100_000_000], ['万', 10_000]]) {
    if (value < size) continue;
    const rest = value % size;
    return chineseInteger(Math.floor(value / size)) + unit
      + (rest ? (rest < size / 10 ? '零' : '') + chineseInteger(rest) : '');
  }
  return [...String(value)].map((digit, index, digits) => digit === '0' ? '零'
    : CHINESE_DIGITS[Number(digit)] + ['', '十', '百', '千'][digits.length - index - 1])
    .join('').replace(/零+/gu, '零').replace(/零$/u, '').replace(/^一十/u, '十');
}

function numberSpellings(number) {
  const [, integer, fraction, unit = '', percent = ''] = /^(\d+)(?:\.(\d+))?([千万亿]?)(%?)$/u.exec(number);
  const digitText = (digits) => [...digits].map((digit) => CHINESE_DIGITS[Number(digit)]).join('');
  const decimal = fraction ? `点${digitText(fraction)}` : '';
  return [number, ...[chineseInteger(Number(integer)), digitText(integer)].filter((value) => value !== null)
    .map((value) => `${percent ? '百分之' : ''}${value}${decimal}${unit}`)];
}

// Both preflight and model-output validation use the same numeric evidence rules.
// Chinese source spellings support Arabic image copy; this is not a semantic fact checker.
export function findUnsupportedImageNumber({ headline, subtitle, bullets }, sourceText) {
  const corpus = withoutListMarkers(normalizeNumericText(sourceText));
  // Complete tokens keep “15”, “5.5” and “5%” from substantiating “5”.
  const evidence = new Set(corpus.match(/(?:百分之)?(?:\d+(?:\.\d+)?[千万亿]?|[零一二三四五六七八九十百千万亿]+(?:点[零一二三四五六七八九]+)?)%?/gu) ?? []);
  const fields = [['标题', headline], ['副标题', subtitle], ...bullets.map((text, index) => [`要点 ${index + 1}`, text])];
  for (const [fieldIndex, [label, text]] of fields.entries()) {
    const normalized = normalizeNumericText(text);
    const numbers = (fieldIndex >= 2 ? withoutListMarkers(normalized) : normalized).match(ARABIC_NUMBER) ?? [];
    for (const number of numbers) {
      if (!numberSpellings(number).some((spelling) => evidence.has(spelling))) return { number, label, text };
    }
  }
  return null;
}
