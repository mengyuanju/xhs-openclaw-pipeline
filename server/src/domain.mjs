export const TASK_STATES = Object.freeze([
  'COPY_QUEUED',
  'COPY_RUNNING',
  'COPY_REVIEW_PENDING',
  'COPY_FAILED',
  'IMAGE_QUEUED',
  'IMAGE_RUNNING',
  'IMAGE_FAILED',
  'DELIVERY_REVIEW_PENDING',
  'COMPLETED',
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
  return String(value instanceof Error ? value.message : value ?? 'Unknown execution failure')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/gu, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}\b/giu, 'Bearer [REDACTED_TOKEN]')
    .slice(0, 2_000);
}
