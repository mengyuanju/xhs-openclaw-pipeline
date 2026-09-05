import { LAYOUT_TEMPLATES_BY_KIND } from './layout-contract.mjs';

const text = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
const list = (items, minItems, maxItems) => ({ type: 'array', items, minItems, maxItems });
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export function visualPlanSchema(post, indices = post.imagePlan.map((_, index) => index + 1)) {
  const variants = indices.map((index) => {
    const kind = post.imagePlan[index - 1].kind;
    return object({
      index: { type: 'integer', enum: [index] }, kind: { type: 'string', enum: [kind] },
      layoutSchemaVersion: { type: 'integer', enum: [1] },
      layoutTemplate: { type: 'string', enum: [...LAYOUT_TEMPLATES_BY_KIND[kind]] },
      sourceEvidence: list(text(200), 1, 3), visualSubject: text(300), layoutDirection: text(300),
      allowedVisibleText: object({
        language: { type: 'string', enum: ['zh-CN'] }, headline: text(18), subtitle: text(30),
        bullets: list(text(kind === 'checklist' ? 40 : 30), 2, 5), labels: list(text(20), 0, 3),
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
