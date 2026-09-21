const IMAGE_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
});

const GENERATED_EDIT_NAME = /^(?:delivery|edit|edited|repair|repaired)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

function safePageNumber(value) {
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1 || page > 9999) {
    throw new RangeError('image page number must be an integer between 1 and 9999');
  }
  return page;
}

function cleanStem(value) {
  const leaf = String(value ?? '').normalize('NFC').replaceAll('\\', '/').split('/').at(-1) ?? '';
  return leaf
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, '_')
    .replace(/\.[a-z0-9]{2,5}$/iu, '')
    .replace(/^source[-_.\s]+/iu, '')
    .replace(/^\d{1,4}(?=$|[-_.\s])[-_.\s]*/u, '')
    .replace(/[. ]+$/gu, '')
    .trim();
}

export function orderedImageFileName(value, position, mediaType = 'image/png') {
  const page = safePageNumber(position);
  const sequence = String(page).padStart(2, '0');
  const extension = IMAGE_EXTENSIONS[String(mediaType)] ?? 'png';
  const hadName = String(value ?? '').trim().length > 0;
  let stem = cleanStem(value);
  if (GENERATED_EDIT_NAME.test(stem)) stem = 'edited';
  if (!stem && !hadName) stem = 'image';
  const maxStemLength = Math.max(0, 120 - sequence.length - extension.length - 2);
  const boundedStem = [...stem].slice(0, maxStemLength).join('');
  return `${sequence}${boundedStem ? `-${boundedStem}` : ''}.${extension}`;
}
