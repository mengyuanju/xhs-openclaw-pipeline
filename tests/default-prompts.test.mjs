import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_PROMPTS, promptFilePath } from '../src/admin/default-prompts.mjs';
import { normalizePromptContent } from '../src/admin/prompt-service.mjs';

describe('runtime default prompts', () => {
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

  it('loads text rules without inline source labels or the legacy icon requirement', () => {
    const prompt = DEFAULT_PROMPTS.find(({ kind }) => kind === 'TEXT_SYSTEM');

    assert.match(prompt.content, /主需关键词/);
    assert.match(prompt.content, /图片内容.*必须与正文一致/);
    assert.match(prompt.content, /文案从初稿到终稿/);
    assert.doesNotMatch(prompt.content, /\[R\d{3}\]/);
    assert.match(prompt.content, /标题和正文.*(?:禁止|不得)使用 emoji/);
    assert.doesNotMatch(prompt.content, /3[–-]6个.*图标/);
  });

  it('loads generation and editing image rules without inline source labels', () => {
    const image = DEFAULT_PROMPTS.find(({ kind }) => kind === 'IMAGE_SYSTEM');
    const edit = DEFAULT_PROMPTS.find(({ kind }) => kind === 'IMAGE_EDIT_SYSTEM');

    for (const prompt of [image, edit]) {
      assert.match(prompt.content, /3:4/);
      assert.match(prompt.content, /图片文字、数据/);
      assert.match(prompt.content, /禁止违法敏感/);
      assert.match(prompt.content, /物体和文字边缘清晰/);
      assert.doesNotMatch(prompt.content, /\[R\d{3}\]/);
    }
    assert.match(edit.content, /\{\{reviewInstruction\}\}/);
  });
});
