const NUMBER = /\d+(?:\.\d+)?%?/gu;

// A structural count is supported by this page's actual entries, not by a new fact.
// Exempt that occurrence only: “核对5项，至少5年经验” still requires evidence for 5年.
export function unsupportedImageNumbers(visible, finalizedText, kind) {
  const supported = new Set(String(finalizedText).match(NUMBER) ?? []);
  const bullets = visible.bullets.map(value => String(value).trim());
  const distinctEntries = bullets.every(Boolean) && new Set(bullets).size === bullets.length;
  const unsupported = [];
  for (const [field, value] of [['headline', visible.headline], ['subtitle', visible.subtitle],
    ...visible.bullets.map(value => ['bullet', value])]) {
    const text = String(value);
    const counts = new Map();
    if (kind === 'checklist' && field !== 'bullet') {
      for (const match of text.matchAll(/(?:核对|检查)\s*(\d+)\s*项(?=$|[，。！？；：、\s])/gu)) {
        counts.set(match.index + match[0].indexOf(match[1]), distinctEntries && Number(match[1]) === bullets.length);
      }
    }
    for (const match of text.matchAll(NUMBER)) {
      if (counts.has(match.index) ? !counts.get(match.index) : !supported.has(match[0])) unsupported.push(match[0]);
    }
  }
  return [...new Set(unsupported)];
}
