import { promptRuntimeSnapshot } from './prompt-runtime.mjs';
import { LAYOUT_TEMPLATES_BY_KIND } from './layout-contract.mjs';
import { requestedLayoutTemplate } from './image-layout-controls.mjs';
import { catalogPageOptions } from './catalog-planning.mjs';

const text = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength });
const list = (items, minItems, maxItems) => ({ type: 'array', items, minItems, maxItems });
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

// The strict-output compiler rejects JSON escapes in enum/const strings.
// Keep those values unchanged in the prompt and enforce them after output via
// normalizeSourceEvidence/assertLockedImageText; never sanitize approved copy.
const supportsLiterals = (values) => values.every(value => !JSON.stringify(value).includes('\\'));
const textChoices = (values, maxLength) => ({
  ...text(maxLength), ...(supportsLiterals(values) ? { enum: [...new Set(values)] } : {}),
});
const lockedText = (value, maxLength, minLength = 1) => ({
  ...text(maxLength, minLength),
  ...(promptRuntimeSnapshot() && supportsLiterals([value]) ? { const: value } : {}),
});

export function visualEvidenceOptions(post) {
  return [...new Set(`${post.title}\n${post.body}`.split(/(?<=[。！？；\n])/u).flatMap((part) => {
    const characters = [...part.trim()];
    const chunks = [];
    for (let offset = 0; offset < characters.length; offset += 200) chunks.push(characters.slice(offset, offset + 200).join(''));
    return chunks;
  }).filter(Boolean))];
}

export function visualPlanSchema(post, indices = post.imagePlan.map((_, index) => index + 1), layoutCatalog = null) {
  const evidenceItems = textChoices(visualEvidenceOptions(post), 200);
  const variants = indices.map((index) => {
    const kind = post.imagePlan[index - 1].kind;
    const candidates = catalogPageOptions(post.imagePlan[index - 1], layoutCatalog);
    return object({
      index: { type: 'integer', enum: [index] }, kind: { type: 'string', enum: [kind] },
      layoutSchemaVersion: { type: 'integer', enum: [candidates ? 2 : 1] },
      ...(candidates ? { layoutKind: { type: 'string', enum: [...new Set(candidates.map(item => item.layoutKind))] },
        templateVersion: { type: 'integer', enum: [...new Set(candidates.map(item => item.templateVersion))] }, selectionReason: text(300) } : {}),
      layoutTemplate: { type: 'string', enum: candidates ? candidates.map(item => item.layoutTemplate) : requestedLayoutTemplate(post.imagePlan[index - 1])
        ? [requestedLayoutTemplate(post.imagePlan[index - 1])] : [...LAYOUT_TEMPLATES_BY_KIND[kind]] },
      sourceEvidence: list(evidenceItems, 1, 3), visualSubject: text(300), layoutDirection: text(300),
      allowedVisibleText: object({
        language: { type: 'string', enum: ['zh-CN'] }, headline: lockedText(post.imagePlan[index - 1].headline, 18),
        subtitle: lockedText(post.imagePlan[index - 1].subtitle, 30, 0),
        // The model schema API rejects array-valued const. Restrict the strings
        // and count here; assertLockedImageText verifies exact order after output.
        bullets: promptRuntimeSnapshot()
          ? list(textChoices(post.imagePlan[index - 1].bullets, kind === 'checklist' ? 40 : 30), post.imagePlan[index - 1].bullets.length, post.imagePlan[index - 1].bullets.length)
          : list(text(kind === 'checklist' ? 40 : 30), 2, 5), labels: list(text(20), 0, promptRuntimeSnapshot() ? 0 : 3),
      }),
      mustShow: list({ ...text(100), pattern: '^画面：.+' }, 0, 10),
      mustAvoid: list(text(100), 1, 10),
    });
  });
  return object({
    schemaVersion: { type: 'integer', enum: [1] },
    ...(layoutCatalog ? { visualStyle: object({ palette: list({ type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, 2, 5), tone: text(100) }) } : {}),
    contentProfile: object({ category: text(100), tones: list(text(30), 1, 5),
      visualMedium: { type: 'string', enum: ['PHOTO', 'ILLUSTRATION', 'INFOGRAPHIC', 'PHOTO_INFOGRAPHIC'] },
      informationDensity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    }),
    pages: list(variants.length === 1 ? variants[0] : { anyOf: variants }, indices.length, indices.length),
  });
}
