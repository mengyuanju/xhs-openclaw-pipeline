import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function promptFilePath(name) {
  return resolve(process.cwd(), 'server', 'prompts', name);
}

function promptFile(name) {
  return readFileSync(promptFilePath(name), 'utf8').trim();
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
