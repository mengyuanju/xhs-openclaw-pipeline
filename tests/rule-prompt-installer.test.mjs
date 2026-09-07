import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAdminStore } from '../src/admin/admin-store.mjs';
import { DEFAULT_PROMPTS } from '../src/admin/default-prompts.mjs';
import { installRulePrompts } from '../src/admin/rule-prompt-installer.mjs';
import { hashPrompt } from '../src/admin/prompt-service.mjs';

describe('rule prompt installer', () => {
  it('keeps the human published version while preparing repository candidates idempotently', () => {
    const store = createAdminStore(':memory:');
    try {
      const textTemplate = store.listPromptTemplates().find(({ kind }) => kind === 'TEXT_SYSTEM');
      const legacy = store.createPromptVersion({
        templateId: textTemplate.id,
        content: '旧版编辑要求：围绕 {{query}} 写作。',
      });
      store.publishPromptVersion(legacy.id);

      const first = installRulePrompts(store);
      const second = installRulePrompts(store);

      assert.equal(first.find(({ kind }) => kind === 'TEXT_SYSTEM').action, 'candidate_exists');
      assert.deepEqual(second, first);
      for (const prompt of DEFAULT_PROMPTS) {
        const template = store.listPromptTemplates().find(({ kind }) => kind === prompt.kind);
        const published = template.versions.find(({ status }) => status === 'PUBLISHED');
        assert.equal(published.contentSha256, prompt.kind === 'TEXT_SYSTEM' ? legacy.contentSha256 : hashPrompt(prompt.content));
      }
    } finally {
      store.close();
    }
  });
});
