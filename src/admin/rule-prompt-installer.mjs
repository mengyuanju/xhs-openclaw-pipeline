import { DEFAULT_PROMPTS } from './default-prompts.mjs';
import { hashPrompt, normalizePromptContent } from './prompt-service.mjs';

export function installRulePrompts(store) {
  if (!store?.listPromptTemplates || !store?.createPromptVersion || !store?.publishPromptVersion) {
    throw new TypeError('admin store with prompt version operations is required');
  }

  const templates = store.listPromptTemplates();
  return DEFAULT_PROMPTS.map((prompt) => {
    const template = templates.find(({ kind }) => kind === prompt.kind);
    if (!template) throw new Error(`prompt template missing for ${prompt.kind}`);

    const content = normalizePromptContent(prompt.content);
    const contentSha256 = hashPrompt(content);
    const existing = template.versions.find((version) => version.contentSha256 === contentSha256);
    if (existing?.status === 'PUBLISHED') {
      return { kind: prompt.kind, version: existing.version, action: 'unchanged', contentSha256 };
    }
    if (existing) {
      const published = store.publishPromptVersion(existing.id);
      return { kind: prompt.kind, version: published.version, action: 'republished', contentSha256 };
    }

    const created = store.createPromptVersion({ templateId: template.id, content });
    const published = store.publishPromptVersion(created.id);
    return { kind: prompt.kind, version: published.version, action: 'installed', contentSha256 };
  });
}
