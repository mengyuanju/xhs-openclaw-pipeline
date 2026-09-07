import { promptRuntimeSnapshot } from './prompt-runtime.mjs';
import { LAYOUT_TEMPLATES_BY_KIND } from './layout-contract.mjs';
import { requestedLayoutTemplate } from './image-layout-controls.mjs';

const text = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
const list = (items, minItems, maxItems) => ({ type: 'array', items, minItems, maxItems });
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export function visualEvidenceOptions(post) {
  return [...new Set(`${post.title}\n${post.body}`.split(/(?<=[。！？；\n])/u).flatMap((part) => {
    const characters = [...part.trim()];
    const chunks = [];
    for (let offset = 0; offset < characters.length; offset += 200) chunks.push(characters.slice(offset, offset + 200).join(''));
    return chunks;
  }).filter(Boolean))];
}

export function visualPlanSchema(post, indices = post.imagePlan.map((_, index) => index + 1)) {
  const variants = indices.map((index) => {
    const kind = post.imagePlan[index - 1].kind;
    return object({
      index: { type: 'integer', enum: [index] }, kind: { type: 'string', enum: [kind] },
      layoutSchemaVersion: { type: 'integer', enum: [1] },
      layoutTemplate: { type: 'string', enum: requestedLayoutTemplate(post.imagePlan[index - 1])
        ? [requestedLayoutTemplate(post.imagePlan[index - 1])] : [...LAYOUT_TEMPLATES_BY_KIND[kind]] },
      sourceEvidence: list(promptRuntimeSnapshot() ? { type: 'string', enum: visualEvidenceOptions(post) } : text(200), 1, 3), visualSubject: text(300), layoutDirection: text(300),
      allowedVisibleText: object({
        language: { type: 'string', enum: ['zh-CN'] }, headline: { ...text(18), ...(promptRuntimeSnapshot() ? { const: post.imagePlan[index - 1].headline } : {}) },
        subtitle: { ...text(30), ...(promptRuntimeSnapshot() ? { const: post.imagePlan[index - 1].subtitle } : {}) },
        // The model schema API rejects array-valued const. Restrict the strings
        // and count here; assertLockedImageText verifies exact order after output.
        bullets: promptRuntimeSnapshot()
          ? list({ type: 'string', enum: [...new Set(post.imagePlan[index - 1].bullets)] }, post.imagePlan[index - 1].bullets.length, post.imagePlan[index - 1].bullets.length)
          : list(text(kind === 'checklist' ? 40 : 30), 2, 5), labels: list(text(20), 0, promptRuntimeSnapshot() ? 0 : 3),
      }),
      mustShow: list({ ...text(100), pattern: '^(画面|文字)：.+' }, 1, 10),
      mustAvoid: list(text(100), 1, 10),
    });
  });
  return object({
    schemaVersion: { type: 'integer', enum: [1] },
    contentProfile: object({ category: text(100), tones: list(text(30), 1, 5),
      visualMedium: { type: 'string', enum: ['PHOTO', 'ILLUSTRATION', 'INFOGRAPHIC', 'PHOTO_INFOGRAPHIC'] },
      informationDensity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    }),
    pages: list(variants.length === 1 ? variants[0] : { anyOf: variants }, indices.length, indices.length),
  });
}
