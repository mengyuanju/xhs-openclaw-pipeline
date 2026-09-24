import {
  ControlPlaneAuthenticationError,
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
} from './domain.mjs';

const REPORT_KEY = 'TASK_DATA_STATISTICS';
const SCHEMA_VERSION = 1;
const TIME_FIELDS = new Set([
  'FIRST_MANUAL_COPY_ASSIGNMENT', 'FIRST_COPY_ASSIGNMENT', 'CREATED_AT',
  'COPY_REVIEW_PASSED_AT', 'COPY_QA_RELEASED_AT',
  'IMAGE_REVIEW_PASSED_AT', 'IMAGE_QA_RELEASED_AT',
]);
const PERSON_FIELDS = new Set([
  'ANNOTATOR', 'COPY_QA_REVIEWER', 'IMAGE_QA_REVIEWER',
  'LAST_COPY_REVIEWER', 'LAST_IMAGE_REVIEWER',
]);
const CONDITION_FIELDS = new Set([
  ...PERSON_FIELDS, 'TASK_ID', 'TASK_NAME', 'STATE', 'COPY_STATUS',
  'IMAGE_STATUS', 'REJECTION_COUNT', 'REASSIGNMENT_COUNT',
]);
const SORT_FIELDS = new Set(['FIRST_MANUAL_COPY_ASSIGNMENT', 'CREATED_AT', 'TASK_ID']);
const NUMERIC_FIELDS = new Set(['TASK_ID', 'REJECTION_COUNT', 'REASSIGNMENT_COUNT']);
const STATUS_FIELDS = new Set(['STATE', 'COPY_STATUS', 'IMAGE_STATUS']);
const STAGE_STATUSES = new Set(['PENDING', 'REVIEW_PASSED', 'QA_PENDING', 'QA_RELEASED', 'RETURNED']);
const COUNT_OPS = new Set(['EQ', 'GTE', 'LTE']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function onlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label} contains unsupported field: ${key}`);
  }
}

function positiveId(value, label) {
  if (typeof value === 'string' && !/^[1-9]\d*$/u.test(value)) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError(`${label} must be a positive integer`);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new TypeError(`${label} must be a positive integer`);
  return id;
}

function nonnegativeInteger(value, label) {
  if (typeof value === 'string' && !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a nonnegative integer`);
  }
  return number;
}

function normalizeDate(value, label) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a YYYY-MM-DD date`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new TypeError(`${label} is not a real calendar date`);
  }
  return value;
}

function normalizeTime(raw) {
  const time = plainObject(raw, 'saved report time');
  onlyKeys(time, ['field', 'mode', 'days', 'from', 'to'], 'saved report time');
  const field = String(time.field ?? 'FIRST_MANUAL_COPY_ASSIGNMENT');
  if (!TIME_FIELDS.has(field)) throw new TypeError('saved report time field is invalid');
  const mode = String(time.mode ?? (time.from || time.to ? 'ABSOLUTE' : 'RELATIVE'));
  if (mode === 'RELATIVE') {
    if (time.from !== undefined || time.to !== undefined) {
      throw new TypeError('relative report time cannot contain fixed dates');
    }
    const days = positiveId(time.days ?? 30, 'saved report relative days');
    if (days > 366) throw new RangeError('saved report relative days cannot exceed 366');
    return { field, mode, days };
  }
  if (mode !== 'ABSOLUTE' || time.days !== undefined) {
    throw new TypeError('saved report time mode is invalid');
  }
  const from = normalizeDate(time.from, 'saved report date from');
  const to = normalizeDate(time.to, 'saved report date to');
  if (from > to) throw new RangeError('saved report date from cannot be after date to');
  return { field, mode, from, to };
}

function normalizeCondition(raw) {
  const condition = plainObject(raw, 'saved report condition');
  onlyKeys(condition, ['field', 'op', 'value'], 'saved report condition');
  const field = String(condition.field ?? '');
  const op = String(condition.op ?? '');
  if (!CONDITION_FIELDS.has(field)) throw new TypeError('saved report condition field is invalid');
  if (PERSON_FIELDS.has(field)) {
    if (op !== 'EQ') throw new TypeError('saved report person condition must use EQ');
    return { field, op, value: positiveId(condition.value, 'saved report person account ID') };
  }
  if (NUMERIC_FIELDS.has(field)) {
    if (!COUNT_OPS.has(op) || (field === 'TASK_ID' && op !== 'EQ')) {
      throw new TypeError('saved report numeric condition operator is invalid');
    }
    const value = field === 'TASK_ID'
      ? positiveId(condition.value, 'saved report task ID')
      : nonnegativeInteger(condition.value, 'saved report count');
    if (field !== 'TASK_ID' && value > 100_000) {
      throw new RangeError('saved report count cannot exceed 100000');
    }
    return { field, op, value };
  }
  if (STATUS_FIELDS.has(field)) {
    if (op !== 'EQ' || typeof condition.value !== 'string'
        || (field === 'STATE' && !/^[A-Z_]{2,40}$/u.test(condition.value))
        || (field !== 'STATE' && !STAGE_STATUSES.has(condition.value))) {
      throw new TypeError('saved report status condition is invalid');
    }
    return { field, op, value: condition.value };
  }
  if (!['EQ', 'CONTAINS'].includes(op) || typeof condition.value !== 'string') {
    throw new TypeError('saved report task name condition is invalid');
  }
  const value = condition.value.trim();
  if (!value || [...value].length > 200) throw new RangeError('saved report task name is too long or empty');
  return { field, op, value };
}

export function normalizeSavedTaskReportQueryConfig(raw) {
  const query = plainObject(raw, 'saved report query');
  onlyKeys(query, ['time', 'match', 'conditions', 'page', 'pageSize', 'sort', 'order', 'columns'], 'saved report query');
  if (query.page !== undefined) positiveId(query.page, 'saved report page');
  const time = normalizeTime(query.time ?? {});
  const match = String(query.match ?? 'ALL');
  if (!['ALL', 'ANY'].includes(match)) throw new TypeError('saved report match is invalid');
  const rawConditions = query.conditions ?? [];
  if (!Array.isArray(rawConditions) || rawConditions.length > 20) {
    throw new TypeError('saved report conditions must contain at most 20 entries');
  }
  const conditions = rawConditions.map(normalizeCondition);
  const pageSize = Number(query.pageSize ?? 50);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new TypeError('saved report pageSize is invalid');
  }
  const sort = String(query.sort ?? 'FIRST_MANUAL_COPY_ASSIGNMENT');
  if (!SORT_FIELDS.has(sort)) throw new TypeError('saved report sort is invalid');
  const order = String(query.order ?? 'DESC');
  if (!['ASC', 'DESC'].includes(order)) throw new TypeError('saved report order is invalid');
  const normalized = { time, match, conditions, pageSize, sort, order };
  if (query.columns !== undefined) {
    if (!Array.isArray(query.columns) || query.columns.length > 60
        || query.columns.some((column) => typeof column !== 'string'
          || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(column))
        || new Set(query.columns).size !== query.columns.length) {
      throw new TypeError('saved report columns are invalid');
    }
    normalized.columns = [...query.columns];
  }
  return normalized;
}

function normalizeName(value) {
  if (typeof value !== 'string') throw new TypeError('saved report query name must be a string');
  const name = value.replace(/\s+/gu, ' ').trim();
  if (!name || [...name].length > 50) {
    throw new RangeError('saved report query name must contain between 1 and 50 characters');
  }
  return name;
}

function normalizeInput(raw, { patch = false } = {}) {
  const input = plainObject(raw, 'saved report query input');
  onlyKeys(input, ['name', 'query', 'isDefault'], 'saved report query input');
  if (patch && Object.keys(input).length === 0) throw new TypeError('saved report query update is empty');
  const normalized = {};
  if (!patch || Object.hasOwn(input, 'name')) normalized.name = normalizeName(input.name);
  if (!patch || Object.hasOwn(input, 'query')) normalized.query = normalizeSavedTaskReportQueryConfig(input.query);
  if (Object.hasOwn(input, 'isDefault')) {
    if (typeof input.isDefault !== 'boolean') throw new TypeError('saved report isDefault must be a boolean');
    normalized.isDefault = input.isDefault;
  } else if (!patch) normalized.isDefault = false;
  return normalized;
}

function normalizeActor(raw) {
  if (!raw || raw.role !== 'ADMIN') {
    throw new ControlPlaneAuthorizationError('task data report is available only to administrators');
  }
  return {
    userId: positiveId(raw.userId, 'administrator account ID'),
    username: String(raw.username ?? '').trim().toLowerCase(),
    credentialVersion: Number.isSafeInteger(Number(raw.credentialVersion))
      && Number(raw.credentialVersion) > 0 ? Number(raw.credentialVersion) : null,
  };
}

async function withAdmin(pool, rawActor, action) {
  const actor = normalizeActor(rawActor);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`
      SELECT id FROM app_users
      WHERE id = $1 AND username = $2 AND role = 'ADMIN' AND status = 'ACTIVE'
        AND ($3::integer IS NULL OR credential_version = $3)
      FOR UPDATE
    `, [actor.userId, actor.username, actor.credentialVersion]);
    if (!current.rows[0]) throw new ControlPlaneAuthenticationError();
    const result = await action(client, actor);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      throw new ControlPlaneConflictError('SAVED_REPORT_QUERY_NAME_EXISTS', '该报表查询方案名称已存在');
    }
    throw error;
  } finally {
    client.release();
  }
}

function fromRow(row) {
  return {
    id: Number(row.id),
    name: row.name,
    query: row.query_config,
    isDefault: row.is_default,
    schemaVersion: Number(row.schema_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSavedTaskReportQueries(pool, actor) {
  return withAdmin(pool, actor, async (client, currentActor) => {
    const result = await client.query(`
      SELECT * FROM saved_task_report_queries
      WHERE owner_account_id = $1 AND report_key = $2
      ORDER BY is_default DESC, updated_at DESC, id DESC
    `, [currentActor.userId, REPORT_KEY]);
    return result.rows.map(fromRow);
  });
}

export async function createSavedTaskReportQuery(pool, actor, rawInput) {
  return withAdmin(pool, actor, async (client, currentActor) => {
    const input = normalizeInput(rawInput);
    if (input.isDefault) {
      await client.query(`UPDATE saved_task_report_queries SET is_default = false, updated_at = now()
        WHERE owner_account_id = $1 AND report_key = $2 AND is_default = true`, [currentActor.userId, REPORT_KEY]);
    }
    const result = await client.query(`
      INSERT INTO saved_task_report_queries
        (owner_account_id, report_key, name, schema_version, query_config, is_default)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [currentActor.userId, REPORT_KEY, input.name, SCHEMA_VERSION, input.query, input.isDefault]);
    return fromRow(result.rows[0]);
  });
}

export async function updateSavedTaskReportQuery(pool, actor, rawId, rawInput) {
  return withAdmin(pool, actor, async (client, currentActor) => {
    const id = positiveId(rawId, 'saved report query ID');
    const input = normalizeInput(rawInput, { patch: true });
    const existing = await client.query(`
      SELECT * FROM saved_task_report_queries WHERE id = $1 AND owner_account_id = $2 AND report_key = $3
      FOR UPDATE
    `, [id, currentActor.userId, REPORT_KEY]);
    if (!existing.rows[0]) throw new ControlPlaneNotFoundError('saved report query not found');
    if (input.isDefault) {
      await client.query(`UPDATE saved_task_report_queries SET is_default = false, updated_at = now()
        WHERE owner_account_id = $1 AND report_key = $2 AND is_default = true AND id <> $3`,
      [currentActor.userId, REPORT_KEY, id]);
    }
    const row = existing.rows[0];
    const result = await client.query(`
      UPDATE saved_task_report_queries
      SET name = $4, query_config = $5, is_default = $6, updated_at = now()
      WHERE id = $1 AND owner_account_id = $2 AND report_key = $3
      RETURNING *
    `, [id, currentActor.userId, REPORT_KEY,
      input.name ?? row.name, input.query ?? row.query_config, input.isDefault ?? row.is_default]);
    return fromRow(result.rows[0]);
  });
}

export async function deleteSavedTaskReportQuery(pool, actor, rawId) {
  return withAdmin(pool, actor, async (client, currentActor) => {
    const id = positiveId(rawId, 'saved report query ID');
    const result = await client.query(`
      DELETE FROM saved_task_report_queries
      WHERE id = $1 AND owner_account_id = $2 AND report_key = $3
      RETURNING id
    `, [id, currentActor.userId, REPORT_KEY]);
    if (!result.rows[0]) throw new ControlPlaneNotFoundError('saved report query not found');
    return { id, deleted: true };
  });
}
