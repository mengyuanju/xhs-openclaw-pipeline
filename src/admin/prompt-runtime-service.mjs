import { PROMPT_CATALOG } from '../prompt-catalog.mjs';
import { createHash } from 'node:crypto';
import { createPromptRuntime, defaultBusinessPrompt, normalizePromptPolicy } from '../prompt-runtime.mjs';
import { normalizePromptContent } from './prompt-service.mjs';
import { promptCompatibilityIssues } from './prompt-preview.mjs';

export function publishedPromptVersions(templates) {
  return Object.fromEntries(templates.flatMap((template) => {
    const version = template.versions.find((item) => item.status === 'PUBLISHED');
    return version ? [[template.kind, { ...version, versionId: version.id, sha256: version.sha256 ?? version.contentSha256 }]] : [];
  }));
}

export async function readPromptConfiguration({ store = null, controlPlane = null }) {
  if (controlPlane) {
    const [templates, records, knowledge] = await Promise.all([controlPlane.listPrompts(), controlPlane.listSettings(), controlPlane.listKnowledge()]);
    const settings = records.find(({ key }) => key === 'prompt_runtime')?.value ?? null;
    return configuration(templates, settings, records.find(({ key }) => key === 'production')?.value ?? {}, knowledge, 'CENTER');
  }
  const templates = store.listPromptTemplates();
  const visual = store.listVisualKnowledge({ status: 'PUBLISHED', pageSize: 100 }).data;
  const copies = [];
  if (store.listCopyKnowledge) {
    let page = 1;
    let result;
    do {
      result = store.listCopyKnowledge({ page, pageSize: 100 });
      copies.push(...result.data.map((item) => ({ kind: 'COPY', itemId: item.id, versionId: item.id,
        versionSource: 'LOCAL_ITEM_SNAPSHOT', contentSha256: createHash('sha256').update(JSON.stringify(item)).digest('hex'), content: item })));
      page += 1;
    } while (page <= result.pagination.totalPages);
  }
  return configuration(templates, store.getPromptRuntimeSettings(), store.getProductionSettings().settings,
    [...copies, ...visual.filter((item) => item.publishedVersion).map((item) => ({ kind: 'VISUAL', itemId: item.id, versionId: item.publishedVersion.id, content: item.publishedVersion }))], 'LOCAL');
}

function configuration(templates, settings, productionSettings, knowledge, source) {
  const enabledKnowledge = productionSettings?.knowledgeEnabled !== false ? knowledge : [];
  const prompts = publishedPromptVersions(templates);
  settings = settings ? normalizePromptPolicy(settings) : null;
  return { templates, settings, productionSettings, knowledge: enabledKnowledge, source,
    promptRuntime: settings ? createPromptRuntime({ prompts, settings, source }) : null,
    systemPrompt: prompts.TEXT_SYSTEM?.content ?? '', imageSystemPrompt: prompts.IMAGE_SYSTEM?.content ?? '',
    visualReference: enabledKnowledge.filter((item) => item.kind === 'VISUAL')
      .map((item) => ({ ...item.content, itemId: item.itemId, versionId: item.versionId }))
      .filter((item) => !item.generationTarget || item.generationTarget === 'MODEL_IMAGE')
      .sort((a, b) => Number(b.qualityScore ?? 0) - Number(a.qualityScore ?? 0))[0] ?? null };
}

export async function preparePromptDrafts({ store, controlPlane }) {
  const templates = controlPlane ? await controlPlane.listPrompts() : store.listPromptTemplates();
  const created = [];
  for (const item of PROMPT_CATALOG) {
    if (templates.some((template) => template.kind === item.kind && template.versions.length)) continue;
    const content = normalizePromptContent(defaultBusinessPrompt(item.kind));
    if (controlPlane) created.push(await controlPlane.createPromptVersion({ kind: item.kind, name: item.label, content }));
    else {
      const template = templates.find((candidate) => candidate.kind === item.kind);
      if (!template) throw new Error(`本地提示词目录缺少 ${item.kind}`);
      created.push(store.createPromptVersion({ templateId: template.id, content }));
    }
  }
  return created;
}

export async function savePromptPolicy(input, { store, controlPlane }) {
  const value = normalizePromptPolicy(input);
  const templates = controlPlane ? await controlPlane.listPrompts() : store.listPromptTemplates();
  const published = publishedPromptVersions(templates);
  for (const [kind, version] of Object.entries(published)) {
    normalizePromptContent(version.content);
    const issues = promptCompatibilityIssues(kind, version.content);
    if (issues.length) throw new TypeError(`${kind}：${issues.join('；')}`);
  }
  const missing = PROMPT_CATALOG.filter(({ kind }) => !['IMAGE_SEARCH_SYSTEM', 'LAYOUT_CATALOG_SYSTEM'].includes(kind)
    && (kind !== 'QUERY_REVIEW_SYSTEM' || value.queryReviewEnabled)
    && (kind !== 'VISUAL_PLAN_SYSTEM' || value.visualPlanningEnabled) && !published[kind]);
  if (missing.length) throw new TypeError(`请先发布以下提示词：${missing.map(({ label }) => label).join('、')}`);
  if (controlPlane) await controlPlane.updateSetting('prompt_runtime', value);
  else store.setPromptRuntimeSettings(value);
  return value;
}

export function promptRuntimeFromSnapshot(snapshot) {
  const settings = snapshot?.productionSettings?.prompt_runtime?.value;
  return settings ? createPromptRuntime({ prompts: snapshot.prompts ?? {}, settings,
    source: 'EXECUTION_SNAPSHOT', capturedAt: snapshot.capturedAt }) : null;
}
