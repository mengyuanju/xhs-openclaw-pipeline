const DECIMAL_INTEGER_PATTERN = /^[0-9]+$/u;

function safeDecimalInteger(value, name) {
  const normalized = typeof value === 'number'
    ? value
    : typeof value === 'string' && DECIMAL_INTEGER_PATTERN.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(normalized)) {
    throw new TypeError(`${name} must be a safe decimal integer`);
  }
  return normalized;
}

export function normalizeListPagination(rawLimit = 50, rawOffset = 0) {
  const limit = safeDecimalInteger(rawLimit, 'limit');
  const offset = safeDecimalInteger(rawOffset, 'offset');
  if (limit < 1 || limit > 200) {
    throw new RangeError('limit must be an integer between 1 and 200');
  }
  if (offset < 0) {
    throw new RangeError('offset must be a non-negative safe integer');
  }
  return { limit, offset };
}
