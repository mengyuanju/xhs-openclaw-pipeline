import { DatabaseSync } from 'node:sqlite';

/** Open the legacy database read-only. Never initialize or migrate its schema. */
export function readLegacyKnowledge(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('BEGIN');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const rows = (table) => tables.has(table) ? db.prepare(`SELECT * FROM ${table}`).all() : [];
    const labels = rows('copy_knowledge_labels').map((r) => ({ id: Number(r.id), name: r.name, createdAt: r.created_at }));
    const names = new Map(labels.map((l) => [l.id, l.name]));
    const links = rows('copy_knowledge_item_labels').sort((a, b) => a.position - b.position);
    const copyItems = rows('copy_knowledge_items').map((r) => ({
      id: Number(r.id), title: r.title, sourceCopy: r.source_copy, sourceCopySha256: r.source_copy_sha256,
      analysisPrompt: r.analysis_prompt, summary: r.summary, analysis: r.analysis, analysisModel: r.analysis_model,
      createdAt: r.created_at, labels: links.filter((l) => l.item_id === r.id).map((l) => names.get(Number(l.label_id))),
    }));
    const analysisPrompts = rows('copy_analysis_prompts').map((r) => ({ id: Number(r.id), content: r.content, createdAt: r.created_at, updatedAt: r.updated_at }));
    const visualItems = rows('visual_knowledge_items');
    const assets = rows('visual_knowledge_assets');
    db.exec('COMMIT');
    return { copyItems, labels, analysisPrompts, visualItems, assets };
  } finally { db.close(); }
}

export async function migrateLegacyKnowledge({ source, store, sourceKey, dryRun = false }) {
  if (typeof sourceKey !== 'string' || !sourceKey.trim()) throw new TypeError('sourceKey is required');
  if (source.visualItems.length || source.assets.length) {
    throw new Error('该迁移工具针对旧版文案库；检测到视觉数据，请先单独迁移参考图片及视觉版本');
  }
  const result = { copyItems: 0, analysisPrompts: 0, visualItems: 0, skipped: 0 };
  if (!dryRun) await store.importCopyKnowledgeLabels(source.labels);
  for (const [items, kind, method, counter] of [
    [source.copyItems, 'COPY', 'importCopyKnowledge', 'copyItems'],
    [source.analysisPrompts, 'PROMPT', 'importCopyAnalysisPrompt', 'analysisPrompts'],
  ]) {
    for (const item of items) {
      const identity = { sourceKey, sourceId: item.id };
      const imported = dryRun
        ? { skipped: await store.hasKnowledgeImport?.({ ...identity, kind }) ?? false }
        : await store[method](item, identity);
      if (imported.skipped) result.skipped++;
      else result[counter]++;
    }
  }
  return result;
}
