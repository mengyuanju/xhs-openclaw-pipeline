/** Split pasted topics in input order; blank segments never create tasks. */
export function parseQueryBatch(value) {
  const queries = String(value ?? '').split(/[\r\n,，]+/u).map((query) => query.trim()).filter(Boolean);
  if (!queries.length) return { queries, error: '请至少输入一条 Query。' };
  if (queries.length > 100) return { queries, error: '一次最多创建 100 条笔记，请分批提交。' };
  const seen = new Map();
  for (const [index, query] of queries.entries()) {
    if ([...query].length > 500) return { queries, error: `第 ${index + 1} 条 Query 超过 500 个字符，请缩短后提交。` };
    if (seen.has(query)) return { queries, error: `第 ${index + 1} 条 Query 与第 ${seen.get(query)} 条重复，请修改后再创建。` };
    seen.set(query, index + 1);
  }
  return { queries, error: '' };
}
