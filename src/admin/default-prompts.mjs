import { readFileSync } from 'node:fs';

function promptFile(name) {
  return readFileSync(new URL(`../../prompts/${name}`, import.meta.url), 'utf8').trim();
}

export const DEFAULT_PROMPTS = [
  {
    slug: 'xiaohongshu-text',
    name: '小红书文案系统提示词',
    kind: 'TEXT_SYSTEM',
    content: promptFile('text-system.md'),
  },
  {
    slug: 'xiaohongshu-image',
    name: '小红书配图系统提示词',
    kind: 'IMAGE_SYSTEM',
    content: promptFile('image-system.md'),
  },
  {
    slug: 'xiaohongshu-image-edit',
    name: '小红书图片编辑系统提示词',
    kind: 'IMAGE_EDIT_SYSTEM',
    content: promptFile('image-edit-system.md'),
  },
];
