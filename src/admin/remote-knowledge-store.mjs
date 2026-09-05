import { createHash } from 'node:crypto';
import { ApiError } from './http.mjs';
import { normalizeCopyKnowledgeInput } from './copy-knowledge-store.mjs';

function latest(item) {
  return [...(item.versions ?? [])].sort((a, b) => b.version - a.version)[0] ?? null;
}

function copyItem(item) {
  const version = latest(item);
  if (!version) return null;
  return { ...version.content, id: item.id, title: version.content?.title ?? item.name,
    sourceCopy: version.content?.sourceCopy ?? '', analysisPrompt: version.content?.analysisPrompt ?? '',
    summary: version.content?.summary ?? '', analysis: version.content?.analysis ?? version.content?.text ?? '',
    labels: version.content?.labels ?? [], createdAt: version.content?.createdAt ?? version.createdAt };
}

function visualItem(item) {
  const version = latest(item);
  if (!version) return null;
  const content = version.content ?? {};
  return { ...content, id: item.id, name: item.name,
    latestVersion: { ...content, ...version, status: item.status === 'ARCHIVED' ? 'RETIRED' : version.status },
    asset: version.storagePath ? { ...content.asset, id: version.id } : null };
}

function pageOf(items, { page = 1, pageSize = 100 } = {}) {
  const size = Math.min(100, Math.max(1, Number(pageSize) || 100));
  const number = Math.max(1, Number(page) || 1);
  return { data: items.slice((number - 1) * size, number * size),
    pagination: { page: number, pageSize: size, totalItems: items.length, totalPages: Math.max(1, Math.ceil(items.length / size)) } };
}

export function createRemoteKnowledgeStore(client) {
  async function copies() {
    return (await client.listKnowledge()).filter((i) => i.kind === 'COPY' && i.status !== 'ARCHIVED')
      .map(copyItem).filter(Boolean).sort((a, b) => b.id - a.id);
  }
  async function saveCopy(input, existing = null, expectedVersionId = null) {
    if (client.knowledgeCapabilities) await client.knowledgeCapabilities();
    const normalized = normalizeCopyKnowledgeInput({ ...input, analysisModel: existing?.analysisModel ?? input.analysisModel });
    const content = { ...existing, ...normalized, labels: normalized.labels.map((l) => l.name),
      sourceCopySha256: createHash('sha256').update(normalized.sourceCopy).digest('hex'),
      createdAt: existing?.createdAt ?? new Date().toISOString() };
    delete content.id;
    const created = await client.createKnowledgeVersion({ itemId: existing?.id ?? null, kind: 'COPY',
      name: content.title, content, publish: true, expectedVersionId });
    if (created.status !== 'PUBLISHED' && !created.skipped) throw new ApiError(503, 'KNOWLEDGE_UPGRADE_REQUIRED', '中心服务需要更新后才能保存文案知识；请先更新 server');
    return { ...content, id: created.itemId, ...(created.skipped ? { importSkipped: true } : {}) };
  }
  return {
    remote: true,
    client,
    async listCopyKnowledge(options = {}) {
      const items = await copies();
      const label = options.label?.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
      return pageOf(label ? items.filter((i) => i.labels.some((l) => l.toLocaleLowerCase('zh-CN') === label)) : items, options);
    },
    async listCopyKnowledgeLabels() {
      const counts = new Map();
      for (const item of await copies()) for (const name of item.labels) counts.set(name, (counts.get(name) ?? 0) + 1);
      return [...counts].map(([name, itemCount]) => ({ name, itemCount })).sort((a, b) => b.itemCount - a.itemCount || a.name.localeCompare(b.name));
    },
    createCopyKnowledge: (input) => saveCopy(input),
    async updateCopyKnowledge(id, input) {
      const item = (await client.listKnowledge()).find((i) => i.id === id && i.kind === 'COPY');
      return item ? saveCopy(input, copyItem(item), latest(item)?.id) : null;
    },
    async deleteCopyKnowledge(id) {
      const item = (await client.listKnowledge()).find((i) => i.id === id && i.kind === 'COPY' && i.status !== 'ARCHIVED');
      if (!item) return false;
      await client.retireKnowledge(id);
      return true;
    },
    listCopyAnalysisPrompts: () => client.listCopyAnalysisPrompts(),
    createCopyAnalysisPrompt: (input) => client.createCopyAnalysisPrompt(input),
    replaceCopyAnalysisPrompt: (id, input) => client.replaceCopyAnalysisPrompt(id, input),
    importCopyKnowledgeLabels: (labels) => client.importCopyKnowledgeLabels(labels),
    async hasKnowledgeImport({ sourceKey, sourceId, kind }) {
      const items = kind === 'COPY' ? await copies()
        : (await client.listSettings()).find((s) => s.key === 'copy_analysis_prompts')?.value ?? [];
      return items.some((item) => item.legacySource?.sourceKey === sourceKey && item.legacySource?.sourceId === sourceId);
    },
    async importCopyKnowledge(input, legacySource) {
      const existing = (await copies()).find((item) => item.legacySource?.sourceKey === legacySource.sourceKey
        && item.legacySource?.sourceId === legacySource.sourceId);
      if (existing) return { item: existing, skipped: true };
      const item = await saveCopy(input, { createdAt: input.createdAt, legacySource });
      return { item, skipped: item.importSkipped ?? false };
    },
    importCopyAnalysisPrompt: (input, legacySource) => client.createCopyAnalysisPrompt({ ...input, legacySource }),
    async listVisualKnowledge(options = {}) {
      let items = (await client.listKnowledge()).filter((i) => i.kind === 'VISUAL').map(visualItem).filter(Boolean).sort((a, b) => b.id - a.id);
      if (options.status) items = items.filter((i) => i.latestVersion.status === options.status);
      if (options.type) items = items.filter((i) => i.type === options.type);
      if (options.query) items = items.filter((i) => i.name.includes(options.query));
      return pageOf(items, options);
    },
    async getVisualKnowledge(id) {
      const item = (await client.listKnowledge()).find((i) => i.id === id && i.kind === 'VISUAL');
      return item ? visualItem(item) : null;
    },
    async createVisualKnowledge(input) {
      const result = await client.createKnowledgeVersion({ kind: 'VISUAL', name: input.name, content: input });
      return { ...input, id: result.itemId, latestVersion: { ...input, id: result.versionId, status: 'DRAFT' } };
    },
    publishVisualKnowledgeVersion: (id) => client.publishKnowledgeVersion(id),
    retireVisualKnowledge: (id) => client.retireKnowledge(id),
    async getProductionSettings() {
      const settings = (await client.listSettings()).find((s) => s.key === 'production')?.value;
      if (!settings) throw new ApiError(503, 'PRODUCTION_SETTINGS_MISSING', '请先在中心服务配置生产设置');
      return { settings };
    },
  };
}
