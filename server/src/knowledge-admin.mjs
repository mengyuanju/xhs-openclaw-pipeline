import { ControlPlaneConflictError, ControlPlaneNotFoundError, normalizeTaskId } from './domain.mjs';

const PROMPTS_KEY = 'copy_analysis_prompts';

async function updateList(pool, key, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO global_settings(key, value) VALUES ($1, '[]'::jsonb) ON CONFLICT(key) DO NOTHING`, [key]);
    const { rows } = await client.query('SELECT value FROM global_settings WHERE key = $1 FOR UPDATE', [key]);
    const items = rows[0].value;
    if (!Array.isArray(items)) throw new TypeError('saved knowledge settings must be an array');
    const result = action(items);
    await client.query('UPDATE global_settings SET value = $2, version = version + 1, updated_at = now() WHERE key = $1', [key, JSON.stringify(items)]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function listCopyAnalysisPrompts(pool) {
  const { rows } = await pool.query('SELECT value FROM global_settings WHERE key = $1', [PROMPTS_KEY]);
  return rows[0]?.value ?? [];
}

export async function saveCopyAnalysisPrompt(pool, input, rawId = null) {
  const id = rawId === null ? null : normalizeTaskId(rawId);
  const content = typeof input?.content === 'string' ? input.content.trim() : '';
  if (!content || [...content].length > 8_000) throw new TypeError('analysis prompt must contain 1 to 8000 characters');
  return updateList(pool, PROMPTS_KEY, (items) => {
    if (input.legacySource) {
      const imported = items.find((p) => p.legacySource?.sourceKey === input.legacySource.sourceKey
        && p.legacySource?.sourceId === input.legacySource.sourceId);
      if (imported) return { item: imported, skipped: true };
    }
    const duplicate = items.find((p) => p.content === content);
    let item = id === null ? null : items.find((p) => p.id === id);
    if (id !== null && !item) throw new ControlPlaneNotFoundError('已保存的分析 Prompt 不存在');
    if (duplicate && duplicate.id !== id) {
      if (id !== null) throw new TypeError('copy analysis prompt already exists');
      if (input.legacySource) {
        duplicate.legacySource = input.legacySource;
        return { item: duplicate, skipped: true };
      }
      return duplicate;
    }
    const now = new Date().toISOString();
    if (!item) {
      if (items.length >= 10) throw new ControlPlaneConflictError('PROMPT_LIMIT_REACHED', '已保存 10 条分析 Prompt，请选择一条进行替换');
      item = { id: Math.max(0, ...items.map((p) => p.id)) + 1, createdAt: input.legacySource ? input.createdAt ?? now : now };
      items.push(item);
    }
    Object.assign(item, { content, updatedAt: input.legacySource ? input.updatedAt ?? now : now });
    if (input.legacySource) item.legacySource = input.legacySource;
    return input.legacySource ? { item, skipped: false } : item;
  });
}

export async function importCopyKnowledgeLabels(pool, labels) {
  if (!Array.isArray(labels)) throw new TypeError('labels must be an array');
  return updateList(pool, 'copy_knowledge_labels', (items) => {
    for (const label of labels) {
      const name = String(label.name ?? '').normalize('NFKC').trim();
      if (!name || [...name].length > 50) throw new TypeError('label is invalid');
      if (!items.some((p) => p.name.toLocaleLowerCase('zh-CN') === name.toLocaleLowerCase('zh-CN'))) items.push({ name });
    }
    return items.length;
  });
}

export async function retireKnowledge(pool, rawId) {
  const id = normalizeTaskId(rawId);
  const result = await pool.query("UPDATE knowledge_items SET status = 'ARCHIVED', updated_at = now() WHERE id = $1 RETURNING id", [id]);
  if (!result.rows[0]) throw new ControlPlaneNotFoundError('知识不存在');
  return { id, status: 'RETIRED' };
}
