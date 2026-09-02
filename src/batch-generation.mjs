export const MIN_BATCH_QUERIES = 2;
export const MAX_BATCH_QUERIES = 20;

function asText(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label}必须是字符串`);
  return value;
}

export function parseBatchQueries(value) {
  const queries = asText(value, '批量选题')
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);

  if (queries.length < MIN_BATCH_QUERIES || queries.length > MAX_BATCH_QUERIES) {
    throw new Error(`每批请输入 ${MIN_BATCH_QUERIES}–${MAX_BATCH_QUERIES} 个选题`);
  }
  const seen = new Set();
  for (const [index, query] of queries.entries()) {
    if (query.length > 500) throw new Error(`第 ${index + 1} 个选题最多 500 字`);
    if (seen.has(query)) throw new Error(`第 ${index + 1} 个选题与前面的内容重复`);
    seen.add(query);
  }
  return queries;
}

export function parseBatchReferenceUrls(value) {
  const urls = [...new Set(asText(value, '参考链接')
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean))];
  if (urls.length > 8) throw new Error('参考链接最多填写 8 条');
  for (const [index, value] of urls.entries()) {
    if (value.length > 500) throw new Error(`第 ${index + 1} 条参考链接最多 500 个字符`);
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`参考链接格式不正确：${value}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error(`参考链接必须是无账号密码的 HTTP(S) 地址：${value}`);
    }
  }
  return urls;
}

export function parseBatchCopyGenerationIds(value) {
  if (!Array.isArray(value)) throw new TypeError('批量生图文案记录必须是数组');
  const ids = [...new Set(value)];
  if (ids.length < 1 || ids.length > MAX_BATCH_QUERIES) {
    throw new Error(`每批请选择 1–${MAX_BATCH_QUERIES} 条已质检文案`);
  }
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
    throw new Error('文案记录 ID 必须是正整数');
  }
  return ids;
}

export function selectApprovedCopyGenerations(value) {
  if (!Array.isArray(value)) throw new TypeError('文案历史记录必须是数组');
  return value.filter((record) => record
    && typeof record === 'object'
    && record.manualReview?.decision === 'APPROVED');
}
