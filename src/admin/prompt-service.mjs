import { createHash } from 'node:crypto';
import { recordPromptRendering } from '../prompt-trace-context.mjs';

export { PROMPT_KINDS } from '../prompt-catalog.mjs';
import { PROMPT_VARIABLES } from '../prompt-catalog.mjs';
export const PROMPT_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'];
export const ALLOWED_PROMPT_VARIABLES = new Set(PROMPT_VARIABLES);

export function normalizePromptContent(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('prompt content cannot be empty');
  }
  const content = value.trim();
  if (Buffer.byteLength(content, 'utf8') > 20_000) {
    throw new RangeError('prompt content cannot exceed 20000 bytes');
  }
  for (const match of content.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    if (!ALLOWED_PROMPT_VARIABLES.has(match[1].trim())) {
      throw new TypeError(`unknown prompt variable: ${match[1].trim()}`);
    }
  }
  return content;
}

export function hashPrompt(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function renderPrompt(content, variables) {
  const normalized = normalizePromptContent(content);
  const rendered = normalized.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g, (_match, name) => {
    const value = variables?.[name];
    return value === undefined || value === null ? '' : String(value);
  });
  recordPromptRendering({ template: normalized, rendered });
  return rendered;
}

