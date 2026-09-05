export const TASK_STATES = Object.freeze([
  'COPY_QUEUED',
  'COPY_RUNNING',
  'COPY_REVIEW_PENDING',
  'COPY_FAILED',
  'IMAGE_QUEUED',
  'IMAGE_RUNNING',
  'IMAGE_FAILED',
  'MANUAL_ARCHIVE',
  'CANCELLED',
]);

export const EXECUTION_KINDS = Object.freeze(['COPY', 'IMAGE']);
export const EXECUTION_STATUSES = Object.freeze([
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'ABANDONED',
]);

const NODE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,100}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IMAGE_PLAN_KINDS = Object.freeze(['hero', 'steps', 'checklist', 'comparison', 'detail', 'summary']);

export class ControlPlaneConflictError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ControlPlaneConflictError';
    this.code = code;
  }
}

export class ControlPlaneNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ControlPlaneNotFoundError';
    this.code = 'NOT_FOUND';
  }
}

export function normalizeNodeId(value) {
  const nodeId = String(value ?? '').trim();
  if (!NODE_ID_PATTERN.test(nodeId)) {
    throw new TypeError('nodeId must contain only letters, numbers, dot, underscore, colon or dash');
  }
  return nodeId;
}

export function normalizeNodeName(value, fallback) {
  const name = String(value ?? fallback ?? '').trim();
  if (name.length < 1 || [...name].length > 100) {
    throw new TypeError('nodeName must contain between 1 and 100 characters');
  }
  return name;
}

export function normalizeCreatorUserId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/u.test(value)) {
    throw new TypeError('createdByUserId must be a valid account identifier');
  }
  return value;
}

export function normalizeUuid(value, name = 'id') {
  const id = String(value ?? '').trim();
  if (!UUID_PATTERN.test(id)) throw new TypeError(`${name} must be a UUID`);
  return id.toLowerCase();
}

export function normalizeTaskId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('taskId must be a positive integer');
  return id;
}

export function normalizeTaskInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('task input must be an object');
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 20_000) {
    throw new RangeError('task input cannot exceed 20000 bytes');
  }
  return JSON.parse(serialized);
}

export function normalizeCreateTask(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('task must be an object');
  }
  const query = String(value.query ?? '').trim();
  if (!query) throw new TypeError('query cannot be empty');
  if ([...query].length > 500) throw new RangeError('query cannot exceed 500 characters');
  const imageCount = value.imageCount ?? 'auto';
  if (imageCount !== 'auto' && ![3, 4, 5].includes(imageCount)) {
    throw new TypeError('imageCount must be auto or an integer from 3 to 5');
  }
  return {
    query,
    input: normalizeTaskInput(value.input ?? {}),
    imageCount,
  };
}

export function normalizeTaskBatch(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new TypeError('tasks must contain between 1 and 100 items');
  }
  return value.map(normalizeCreateTask);
}

function normalizedReviewText(value, field, { min = 1, max }) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const text = value.replace(/\r\n?/gu, '\n').trim();
  if ([...text].length < min || [...text].length > max) {
    throw new RangeError(`${field} must contain between ${min} and ${max} characters`);
  }
  return text;
}

function normalizedReviewTextList(value, field, { min, max, itemMax }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new RangeError(`${field} must contain between ${min} and ${max} items`);
  }
  return value.map((item, index) => normalizedReviewText(item, `${field}[${index}]`, { max: itemMax }));
}

export function normalizeCopyReviewEdits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('copy review edits must be an object');
  }
  const copy = value.copy;
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) {
    throw new TypeError('copy review edits.copy must be an object');
  }
  const tags = normalizedReviewTextList(copy.tags, 'copy review tags', {
    min: 3,
    max: 8,
    itemMax: 20,
  });
  if (tags.some((tag) => !/^#[^#\s]+$/u.test(tag)) || new Set(tags).size !== tags.length) {
    throw new TypeError('copy review tags must be unique hashtags without whitespace');
  }
  if (!Array.isArray(value.imagePlan) || value.imagePlan.length < 3 || value.imagePlan.length > 5) {
    throw new RangeError('copy review imagePlan must contain between 3 and 5 items');
  }
  const imagePlan = value.imagePlan.map((rawItem, index) => {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      throw new TypeError(`copy review imagePlan[${index}] must be an object`);
    }
    const kind = String(rawItem.kind ?? '').trim();
    if (!IMAGE_PLAN_KINDS.includes(kind)) {
      throw new TypeError(`copy review imagePlan[${index}].kind is invalid`);
    }
    return {
      kind,
      headline: normalizedReviewText(rawItem.headline, `copy review imagePlan[${index}].headline`, { max: 18 }),
      subtitle: normalizedReviewText(rawItem.subtitle, `copy review imagePlan[${index}].subtitle`, { max: 30 }),
      bullets: normalizedReviewTextList(rawItem.bullets, `copy review imagePlan[${index}].bullets`, {
        min: 2,
        max: 5,
        itemMax: kind === 'checklist' ? 40 : 30,
      }),
      prompt: normalizedReviewText(rawItem.prompt, `copy review imagePlan[${index}].prompt`, {
        min: 10,
        max: 1_000,
      }),
    };
  });
  if (imagePlan[0].kind !== 'hero' || imagePlan.slice(1).some((item) => item.kind === 'hero')) {
    throw new TypeError('copy review imagePlan must contain hero only as its first item');
  }
  return {
    copy: {
      title: normalizedReviewText(copy.title, 'copy review title', { max: 25 }),
      body: normalizedReviewText(copy.body, 'copy review body', { min: 400, max: 600 }),
      tags,
    },
    imagePlan,
  };
}

export function normalizeStage(value) {
  const stage = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(stage)) throw new TypeError('stage is invalid');
  return stage;
}

export function normalizeProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('progress must be an object');
  }
  const progressPercent = Number(value.progressPercent ?? 0);
  if (!Number.isInteger(progressPercent) || progressPercent < 0 || progressPercent > 100) {
    throw new TypeError('progressPercent must be an integer from 0 to 100');
  }
  const message = String(value.message ?? '').trim();
  if ([...message].length > 500) throw new RangeError('progress message cannot exceed 500 characters');
  return {
    stage: normalizeStage(value.stage),
    progressPercent,
    message,
    details: normalizeJson(value.details ?? {}, 'progress details', 32_000),
  };
}

export function normalizeJson(value, name, maxBytes = 2_000_000) {
  if (value === undefined) throw new TypeError(`${name} is required`);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError(`${name} must be JSON serializable`);
  }
  if (serialized === undefined) throw new TypeError(`${name} must be JSON serializable`);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new RangeError(`${name} cannot exceed ${maxBytes} bytes`);
  }
  return JSON.parse(serialized);
}

export function redactExecutionError(value) {
  const redacted = String(value instanceof Error ? value.message : value ?? 'Unknown execution failure')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/gu, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}\b/giu, 'Bearer [REDACTED_TOKEN]');
  return [...redacted].slice(0, 2_000).join('');
}
