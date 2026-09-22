const MAX_QUERY_HEADER_BYTES = 64 * 1024;

export function originalDeliveryQuery({ issuedQuery, query }) {
  return String(String(issuedQuery ?? '').trim() || query || '')
    .replace(/[\r\n]+/gu, ' ')
    .replace(/[\u0000-\u001f\u007f]/gu, '\uFFFD')
    .trim();
}

function replaceQueryHeader(bytes, query) {
  const end = bytes.findIndex(value => value === 13 || value === 10);
  const length = end < 0 ? bytes.length : end;
  const header = bytes.subarray(0, length).toString('utf8');
  const prefix = /^(\uFEFF?原始[ \t]*Query[：:])/iu.exec(header)?.[1];
  if (!prefix) return bytes;
  return Buffer.concat([Buffer.from(prefix + query, 'utf8'), bytes.subarray(length)]);
}

// Only the original Query header is updated. Keep all remaining bytes, including
// line endings and the frozen copy body, and bound memory even for malformed TXT.
export async function* withOriginalDeliveryQuery(chunks, task) {
  const query = originalDeliveryQuery(task);
  let pending = Buffer.alloc(0), passedHeader = false;
  for await (const chunk of chunks) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (passedHeader) { yield bytes; continue; }
    pending = Buffer.concat([pending, bytes]);
    const end = pending.findIndex(value => value === 13 || value === 10);
    if (end < 0 && pending.length <= MAX_QUERY_HEADER_BYTES) continue;
    yield end >= 0 && end <= MAX_QUERY_HEADER_BYTES ? replaceQueryHeader(pending, query) : pending;
    passedHeader = true;
    pending = Buffer.alloc(0);
  }
  if (!passedHeader && pending.length) yield replaceQueryHeader(pending, query);
}
