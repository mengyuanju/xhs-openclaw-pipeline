import { ControlPlaneNotFoundError, normalizeTaskId, normalizeUuid } from './domain.mjs';

const TEXT_LIMIT = 200_000;

// Defense in depth: even direct API uploads must not persist obvious credentials.
export function sanitizeModelCallText(value) {
  return String(value).replace(/\bsk-[a-zA-Z0-9_-]{8,}/gu, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"',}]+/giu, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|password|secret|access[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s"',}\n]+/giu, '$1[REDACTED]')
    .replace(/data:image\/[^;]+;base64,[a-zA-Z0-9+/=]+/gu, '[image data omitted]')
    .replace(/\u0000/gu, '').slice(0, TEXT_LIMIT);
}

function shortText(value, name, max) {
  if (typeof value !== 'string' || value.length > max) throw new TypeError(`${name} is invalid`);
  return sanitizeModelCallText(value);
}

function date(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} is invalid`);
  return new Date(value).toISOString();
}

export function normalizeModelCall(input) {
  if (!input || !Number.isInteger(input.sequence) || input.sequence < 1 || input.sequence > 2_147_483_647) {
    throw new TypeError('model call sequence is invalid');
  }
  if (!['RUNNING', 'SUCCEEDED', 'FAILED'].includes(input.status)) throw new TypeError('model call status is invalid');
  for (const field of ['prompt', 'request']) {
    if (typeof input[field] !== 'string') throw new TypeError(`${field} must be a string`);
  }
  for (const field of ['response', 'error']) {
    if (input[field] != null && typeof input[field] !== 'string') throw new TypeError(`${field} must be a string`);
  }
  const startedAt = date(input.startedAt, 'startedAt');
  const finishedAt = input.status === 'RUNNING' ? null : date(input.finishedAt, 'finishedAt');
  const durationMs = input.status === 'RUNNING' ? null : input.durationMs;
  if (durationMs !== null && (!Number.isSafeInteger(durationMs) || durationMs < 0)) throw new TypeError('durationMs is invalid');
  return {
    sequence: input.sequence, stage: shortText(input.stage, 'stage', 64),
    provider: shortText(input.provider, 'provider', 64), operation: shortText(input.operation, 'operation', 64),
    model: shortText(input.model ?? '', 'model', 200), status: input.status,
    prompt: sanitizeModelCallText(input.prompt), request: sanitizeModelCallText(input.request),
    response: input.response == null ? null : sanitizeModelCallText(input.response),
    error: input.error == null ? null : sanitizeModelCallText(input.error),
    truncated: Boolean(input.truncated) || ['prompt', 'request', 'response', 'error'].some((key) => input[key]?.length > TEXT_LIMIT),
    startedAt, finishedAt, durationMs,
  };
}

const summaryColumns = `c.id, c.task_id AS "taskId", c.execution_id AS "executionId", c.sequence,
  c.stage, c.provider, c.operation, c.model, c.status, c.truncated,
  c.started_at AS "startedAt", c.finished_at AS "finishedAt", c.duration_ms::float8 AS "durationMs",
  e.kind, e.node_id AS "nodeId", e.started_at AS "executionStartedAt"`;

export async function saveModelCall(pool, rawExecutionId, rawCallId, input) {
  const executionId = normalizeUuid(rawExecutionId, 'executionId');
  const callId = normalizeUuid(rawCallId, 'callId');
  const record = normalizeModelCall(input);
  const result = await pool.query(`
    INSERT INTO model_call_traces(id, task_id, execution_id, sequence, stage, provider, operation,
      model, status, prompt, request, response, error, truncated, started_at, finished_at, duration_ms)
    SELECT $1, e.task_id, e.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
    FROM task_executions e WHERE e.id = $2
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, response = EXCLUDED.response,
      error = EXCLUDED.error, truncated = model_call_traces.truncated OR EXCLUDED.truncated,
      finished_at = EXCLUDED.finished_at, duration_ms = EXCLUDED.duration_ms
    WHERE model_call_traces.execution_id = EXCLUDED.execution_id AND model_call_traces.status = 'RUNNING'
    RETURNING id
  `, [callId, executionId, record.sequence, record.stage, record.provider, record.operation,
    record.model, record.status, record.prompt, record.request, record.response, record.error,
    record.truncated, record.startedAt, record.finishedAt, record.durationMs]);
  if (!result.rows.length) {
    const existing = await pool.query('SELECT id FROM model_call_traces WHERE id = $1 AND execution_id = $2', [callId, executionId]);
    if (!existing.rows.length) throw new ControlPlaneNotFoundError('execution or model call not found');
  }
  return { id: callId };
}

export async function listModelCalls(pool, rawTaskId, { limit = 20, offset = 0 } = {}) {
  const taskId = normalizeTaskId(rawTaskId);
  limit = Number(limit); offset = Number(offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError('model call pagination is invalid');
  }
  const result = await pool.query(`SELECT ${summaryColumns} FROM model_call_traces c
    JOIN task_executions e ON e.id = c.execution_id WHERE c.task_id = $1
    ORDER BY e.started_at, e.id, c.sequence, c.id LIMIT $2 OFFSET $3`, [taskId, limit, offset]);
  const count = await pool.query('SELECT count(*)::integer AS total FROM model_call_traces WHERE task_id = $1', [taskId]);
  return { items: result.rows, total: count.rows[0].total, limit, offset };
}

export async function getModelCall(pool, rawTaskId, rawCallId) {
  const result = await pool.query(`SELECT ${summaryColumns}, c.prompt, c.request, c.response, c.error
    FROM model_call_traces c JOIN task_executions e ON e.id = c.execution_id
    WHERE c.task_id = $1 AND c.id = $2`, [normalizeTaskId(rawTaskId), normalizeUuid(rawCallId, 'callId')]);
  if (!result.rows[0]) throw new ControlPlaneNotFoundError('model call not found');
  return result.rows[0];
}
