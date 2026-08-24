import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_PROMPTS, promptFilePath } from '../src/admin/default-prompts.mjs';
import { normalizePromptContent } from '../src/admin/prompt-service.mjs';

describe('source-traceable default prompts', () => {
  it('provides one valid prompt for each runtime prompt kind', () => {
    const textPromptPath = promptFilePath('text-system.md');
    assert.equal(typeof textPromptPath, 'string');
    assert.equal(isAbsolute(textPromptPath), true);
    assert.deepEqual(
      DEFAULT_PROMPTS.map(({ kind }) => kind).sort(),
      ['IMAGE_EDIT_SYSTEM', 'IMAGE_SYSTEM', 'TEXT_SYSTEM'],
    );
    for (const prompt of DEFAULT_PROMPTS) {
      assert.equal(normalizePromptContent(prompt.content), prompt.content.trim());
    }
  });

  it('loads text rules with source ids and no legacy icon requirement', () => {
    const prompt = DEFAULT_PROMPTS.find(({ kind }) => kind === 'TEXT_SYSTEM');

    assert.match(prompt.content, /\[R017\]/);
    assert.match(prompt.content, /\[R049\]/);
    assert.match(prompt.content, /\[R095\]/);
    assert.match(prompt.content, /标题和正文.*(?:禁止|不得)使用 emoji/);
    assert.doesNotMatch(prompt.content, /3[–-]6个.*图标/);
  });

  it('loads generation and editing image rules with source ids', () => {
    const image = DEFAULT_PROMPTS.find(({ kind }) => kind === 'IMAGE_SYSTEM');
    const edit = DEFAULT_PROMPTS.find(({ kind }) => kind === 'IMAGE_EDIT_SYSTEM');

    for (const prompt of [image, edit]) {
      assert.match(prompt.content, /\[R053\]/);
      assert.match(prompt.content, /\[R080\]/);
      assert.match(prompt.content, /\[R083\]/);
      assert.match(prompt.content, /\[R099\]/);
    }
    assert.match(edit.content, /\{\{reviewInstruction\}\}/);
  });
});
