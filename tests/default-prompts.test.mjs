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
    assert.doesNotMatch(prompt.content, /人工语言排版微调/);
    assert.match(prompt.content, /imagePlan 必须按正文逻辑逐张规划全部 \{\{imageCount\}\} 张图片/);
    assert.match(prompt.content, /每张都提供非空模型提示词/);
    assert.doesNotMatch(prompt.content, /\[R\d{3}\]/);
    assert.match(prompt.content, /标题和正文.*(?:禁止|不得)使用 emoji/);
    assert.doesNotMatch(prompt.content, /3[–-]6个.*图标/);
  });

  it('requires type-aware natural copy instead of a default numbered-step template', () => {
    const prompt = DEFAULT_PROMPTS.find(({ kind }) => kind === 'TEXT_SYSTEM');

    assert.match(prompt.content, /按内容类型选择结构/u);
    assert.match(prompt.content, /教程或操作流程/u);
    assert.match(prompt.content, /推荐、盘点、对比测评/u);
    assert.match(prompt.content, /科普、知识、答疑/u);
    assert.match(prompt.content, /不得默认写成“第一步、第二步、第三步”/u);
    assert.match(prompt.content, /不得编造第一人称/u);
    assert.match(prompt.content, /联网研究由 Worker 在文本生成前完成/u);
    assert.match(prompt.content, /webResearch.*不可信/u);
    assert.match(prompt.content, /不得声称打开或抓取了快照未包含的网页/u);
  });

  it('defines the copy-only three-point acceptance gate measured by the latest trial', () => {
    const prompt = DEFAULT_PROMPTS.find(({ kind }) => kind === 'TEXT_SYSTEM');

    assert.match(prompt.content, /文案 3 分门禁/u);
    assert.match(prompt.content, /标题前半段.*完整主需.*后半段.*交付内容/u);
    assert.match(prompt.content, /数字承诺.*正文.*实际条数/u);
    assert.match(prompt.content, /正文前两句.*直接回答 Query/u);
    assert.match(prompt.content, /没有输入支持.*朋友问我.*上一份工作.*打电话问家人/u);
    assert.match(prompt.content, /标题、正文和 imagePlan.*数字、顺序和结论一致/u);
    assert.match(prompt.content, /错别字、重复段落和多余空行/u);
    assert.doesNotMatch(prompt.content, /使用 2[—-]3 个 AI 工具交叉验证/u);
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
    assert.match(image.content, /整套图片由图像模型一次性完成场景与文字排版/u);
    assert.match(image.content, /图像模型一次性完成场景与文字排版/u);
    assert.doesNotMatch(image.content, /固定简体中文字体确定性排版/u);
    assert.doesNotMatch(image.content, /不得生成任何文字、字母、数字、伪文字/);
    assert.match(image.content, /后续图片引用第一张/);
    assert.match(image.content, /至少 3 种不同的版式骨架/);
    assert.match(image.content, /封面标题最多 2 行/);
    assert.match(image.content, /内页禁止海报式满版大字/);
    assert.doesNotMatch(image.content, /本地模板/);
    assert.match(edit.content, /\{\{reviewInstruction\}\}/);
  });
});
