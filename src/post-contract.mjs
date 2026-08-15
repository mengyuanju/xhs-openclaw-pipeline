import { readFileSync } from 'node:fs';

const PROMPT_TEMPLATE = readFileSync(new URL('../prompts/post.md', import.meta.url), 'utf8');
const IMAGE_KINDS = ['hero', 'steps', 'checklist'];
const FABRICATED_EXPERIENCE = /(我亲测|亲测有效|我用了.{0,8}(个月|年)|本人购买|我家一直|绝对有效)/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function visibleLength(value) {
  return [...value].length;
}

function expectRecord(value, field) {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function expectString(value, field, { min = 1, max = 1_000, allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const text = value.trim();
  if (!allowEmpty && visibleLength(text) < min) throw new RangeError(`${field} is too short`);
  if (visibleLength(text) > max) throw new RangeError(`${field} cannot exceed ${max} characters`);
  return text;
}

function expectBoolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
  return value;
}

function expectEnum(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function expectStringArray(value, field, { min = 0, max = 10, itemMax = 200 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new RangeError(`${field} must contain between ${min} and ${max} items`);
  }
  return value.map((item, index) => expectString(item, `${field}[${index}]`, { max: itemMax }));
}

function parseJsonFragments(raw) {
  const fragments = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fenced) fragments.push(fenced[1].trim());
  fragments.push(raw.trim());

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) fragments.push(raw.slice(start, index + 1));
    }
  }
  return [...new Set(fragments)];
}

function parseFirstObject(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new TypeError('model output must be a non-empty string');
  }
  for (const fragment of parseJsonFragments(raw)) {
    try {
      const parsed = JSON.parse(fragment);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next balanced or fenced JSON candidate.
    }
  }
  throw new SyntaxError('model output does not contain a valid JSON object');
}

function validateImagePlan(value) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new RangeError('imagePlan must contain hero, steps and checklist exactly once');
  }
  const images = value.map((raw, index) => {
    const image = expectRecord(raw, `imagePlan[${index}]`);
    const kind = expectEnum(image.kind, `imagePlan[${index}].kind`, IMAGE_KINDS);
    const prompt = expectString(image.prompt, `imagePlan[${index}].prompt`, {
      min: kind === 'hero' ? 10 : 0,
      max: 600,
      allowEmpty: kind !== 'hero',
    });
    if (kind !== 'hero' && prompt !== '') {
      throw new TypeError(`imagePlan ${kind} prompt must be empty`);
    }
    return {
      kind,
      headline: expectString(image.headline, `imagePlan[${index}].headline`, { max: 18 }),
      subtitle: expectString(image.subtitle, `imagePlan[${index}].subtitle`, { max: 30 }),
      bullets: expectStringArray(image.bullets, `imagePlan[${index}].bullets`, {
        min: 2,
        max: 5,
        itemMax: 30,
      }),
      prompt,
    };
  });
  if (images.some((image, index) => image.kind !== IMAGE_KINDS[index])) {
    throw new TypeError('imagePlan order must be hero, steps, checklist');
  }
  return images;
}

function validatePost(value) {
  const root = expectRecord(value, 'post');
  const judgement = expectRecord(root.taskJudgement, 'taskJudgement');
  const platform = expectRecord(root.platform, 'platform');
  const title = expectString(root.title, 'title', { max: 25 });
  const body = expectString(root.body, 'body', { min: 200, max: 1_200 });

  if (/[!！~～]/u.test(title)) throw new TypeError('title cannot contain exclamation marks or decorative tildes');
  if (FABRICATED_EXPERIENCE.test(body) || root.fabricatedExperience !== false) {
    throw new TypeError('fabricated experience is not allowed');
  }
  const titleEmojiCount = (title.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  const bodyEmojiCount = (body.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  if (titleEmojiCount > 1) throw new TypeError('title can contain at most one semantic icon');
  if (bodyEmojiCount < 3 || bodyEmojiCount > 6) {
    throw new TypeError('body must contain between 3 and 6 semantic navigation icons');
  }

  const iconDictionary = expectRecord(platform.iconDictionary, 'platform.iconDictionary');
  const safeIcons = {};
  for (const [icon, meaning] of Object.entries(iconDictionary)) {
    if (Object.keys(safeIcons).length >= 6) throw new RangeError('platform.iconDictionary cannot exceed 6 entries');
    safeIcons[expectString(icon, 'platform.iconDictionary key', { max: 4 })] = expectString(
      meaning,
      `platform.iconDictionary.${icon}`,
      { max: 12 },
    );
  }

  const tags = expectStringArray(root.tags, 'tags', { min: 3, max: 8, itemMax: 20 });
  if (tags.some((tag) => !/^#[^#\s]+$/u.test(tag))) {
    throw new TypeError('tags must start with # and contain no whitespace');
  }

  const admitted = expectBoolean(judgement.admitted, 'taskJudgement.admitted');
  if (!admitted) throw new TypeError('taskJudgement.admitted must be true for production');

  return {
    taskJudgement: {
      admitted,
      demandLevel: expectEnum(judgement.demandLevel, 'taskJudgement.demandLevel', ['strong', 'medium']),
      primaryType: expectEnum(judgement.primaryType, 'taskJudgement.primaryType', ['教程']),
      reason: expectString(judgement.reason, 'taskJudgement.reason', { max: 200 }),
    },
    platform: {
      target: expectEnum(platform.target, 'platform.target', ['小红书']),
      expressionType: expectEnum(platform.expressionType, 'platform.expressionType', ['信息型']),
      audience: expectString(platform.audience, 'platform.audience', { max: 100 }),
      openingMethod: expectString(platform.openingMethod, 'platform.openingMethod', { max: 150 }),
      bodyStructure: expectString(platform.bodyStructure, 'platform.bodyStructure', { max: 150 }),
      iconDictionary: safeIcons,
      sampleEvidence: expectEnum(platform.sampleEvidence, 'platform.sampleEvidence', [
        'not_provided',
        'limited',
        'sufficient',
      ]),
    },
    title,
    body,
    tags,
    imagePlan: validateImagePlan(root.imagePlan),
    sources: expectStringArray(root.sources, 'sources', { max: 8, itemMax: 500 }),
    expressionReferences: expectStringArray(root.expressionReferences, 'expressionReferences', {
      max: 5,
      itemMax: 500,
    }),
    riskFlags: expectStringArray(root.riskFlags, 'riskFlags', { max: 10, itemMax: 200 }),
    fabricatedExperience: expectBoolean(root.fabricatedExperience, 'fabricatedExperience'),
    unverifiedClaims: expectStringArray(root.unverifiedClaims, 'unverifiedClaims', { max: 10, itemMax: 300 }),
  };
}

export function buildPostPrompt({ query, input = {} }) {
  return PROMPT_TEMPLATE.replace('{{TASK_JSON}}', JSON.stringify({ query, input }, null, 2));
}

export function parsePostOutput(raw) {
  return validatePost(parseFirstObject(raw));
}
