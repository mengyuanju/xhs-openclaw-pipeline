export const CLIENT_BATCH_CODE_PATTERN = /^[0-9a-f]{32}$/u;

export function normalizeClientBatchCode(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || String(value).trim() === '')) {
    return null;
  }
  if (typeof value !== 'string') throw new TypeError('clientBatchCode must be a string');
  const code = value.trim().toLowerCase();
  if (!CLIENT_BATCH_CODE_PATTERN.test(code)) {
    throw new RangeError('clientBatchCode must be a 32-character hexadecimal identifier');
  }
  return code;
}
