import { createAgentClient } from './agent-client.mjs';
import { businessPrompt } from './prompt-runtime.mjs';
import { importLayoutTemplates, LAYOUT_FAMILIES, CONTENT_PAGE_KINDS } from '../server/src/layout-catalog.mjs';

const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const layoutCandidateSchema = object({ templates: { type: 'array', minItems: 1, maxItems: 10, items: object({
  layoutTemplate: { ...text(80), pattern: '^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$' }, templateVersion: { type: 'integer', minimum: 2, maximum: 10000 },
  layoutKind: { type: 'string', enum: Object.keys(LAYOUT_FAMILIES) }, name: text(60), description: text(300), suitableContent: text(300),
  applicablePageKinds: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', enum: CONTENT_PAGE_KINDS } },
  subjectRegion: text(300), textRegion: text(300), readingOrder: text(300), minItems: { type: 'integer', minimum: 1, maximum: 6 }, maxItems: { type: 'integer', minimum: 1, maximum: 6 },
  rules: { type: 'array', minItems: 1, maxItems: 8, items: text(200) },
}) } });

function validateCandidates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'templates')) throw new TypeError('模型模板返回字段无效');
  if (!Array.isArray(value.templates) || value.templates.length < 1 || value.templates.length > 10) throw new TypeError('模型模板需为1～10条');
  const fields = Object.keys(layoutCandidateSchema.properties.templates.items.properties);
  // These lexical checks reject obvious non-design payloads. All text remains untrusted
  // data afterwards; it is never evaluated, used as SQL, or resolved as a file path.
  const operational = /```|<\/?script\b|\b(?:DROP|ALTER|CREATE|TRUNCATE)\s+(?:TABLE|DATABASE)\b|\b(?:INSERT\s+INTO|DELETE\s+FROM|SELECT\s+[^\n]{1,100}\s+FROM)\b|\bUPDATE\s+\w+\s+SET\b|[A-Z]:[\\/]|\\\\[\w.-]+\\|file:\/\/|(?:^|[\s"'：])\/(?:[\w.-]+\/)+|\b(?:eval|exec|spawn|require)\s*\(|\b(?:const|let|var)\s+\w+\s*=/iu;
  for (const template of value.templates) {
    if (!template || typeof template !== 'object' || Array.isArray(template) || Object.keys(template).some(key => !fields.includes(key))) throw new TypeError('模型模板包含未允许的字段');
    const prose = ['name', 'description', 'suitableContent', 'subjectRegion', 'textRegion', 'readingOrder'].map(key => template[key]);
    if ([...prose, ...(Array.isArray(template.rules) ? template.rules : [])].some(text => typeof text === 'string' && operational.test(text))) throw new TypeError('模型模板仅接受版式说明，不能包含代码、SQL或文件路径');
  }
  return importLayoutTemplates(null, value.templates, { source: 'MODEL' }).catalog.templates;
}

export async function generateLayoutCandidates({ brief, catalog, modelApi = {}, client = undefined }) {
  if (typeof brief !== 'string' || !brief.trim() || [...brief].length > 2000) throw new TypeError('版式需求需为1～2000字');
  const prompt = businessPrompt('LAYOUT_CATALOG_SYSTEM', { contract: '返回模板 JSON，遵循提供的 schema。仅提出可复用版式，不返回任务文案、代码、SQL或文件路径。新模板使用新编码，修改现有模板须增加版本。source、enabled由程序设置。',
    data: { brief, families: LAYOUT_FAMILIES, existingTemplates: catalog?.templates?.map(({ layoutTemplate, templateVersion, description }) => ({ layoutTemplate, templateVersion, description })) ?? [] } });
  const result = await (client ?? createAgentClient({ modelApi })).runText({ prompt, outputSchema: layoutCandidateSchema, thinking: 'low' });
  if (typeof result.rawText !== 'string' || result.rawText.length > 100_000) throw new TypeError('模型模板返回过大或为空');
  let value;
  try { value = JSON.parse(result.rawText.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')); }
  catch { throw new TypeError('模型没有返回有效模板 JSON，未导入'); }
  const templates = validateCandidates(value);
  return { templates, model: typeof result.model === 'string' ? result.model.slice(0, 200) : null };
}
