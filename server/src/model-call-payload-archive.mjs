import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
// Four legal 200,000-character texts can expand to 4.8 MB when JSON escapes
// control characters or unpaired surrogates. Preserve all sanitized text.
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const PAYLOAD_FIELDS = Object.freeze(['prompt', 'request', 'response', 'error']);
const cursors = new WeakMap();
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const firstCursor = () => ({ finishedAt: '-infinity', executionId: ZERO_UUID, id: ZERO_UUID });

function bounded(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function retentionDays(value = 7) {
  if (!Number.isSafeInteger(value) || value < 7 || value > 3650) {
    throw new TypeError('model call archive retentionDays must be between 7 and 3650');
  }
  return value;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== PAYLOAD_FIELDS.length
    || typeof payload.prompt !== 'string' || typeof payload.request !== 'string'
    || !PAYLOAD_FIELDS.slice(2).every(key => payload[key] === null || typeof payload[key] === 'string')) {
    throw new Error('model call archived payload is invalid');
  }
  return payload;
}

export async function encodeModelCallPayload(record) {
  const payload = validatePayload(Object.fromEntries(PAYLOAD_FIELDS.map(key => [key, record[key]])));
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  if (raw.length > MAX_PAYLOAD_BYTES) throw new Error('model call archived payload is too large');
  return { payload: await compress(raw), rawBytes: raw.length,
    sha256: createHash('sha256').update(raw).digest('hex') };
}

export async function decodeModelCallPayload(record) {
  if (Number(record.format_version) !== 1 || !Buffer.isBuffer(record.payload)
    || !Number.isSafeInteger(Number(record.raw_bytes))
    || Number(record.raw_bytes) < 1 || Number(record.raw_bytes) > MAX_PAYLOAD_BYTES) {
    throw new Error('model call archived payload is invalid');
  }
  const raw = await decompress(record.payload, { maxOutputLength: Number(record.raw_bytes) });
  if (raw.length !== Number(record.raw_bytes)
    || createHash('sha256').update(raw).digest('hex') !== record.sha256) {
    throw new Error('model call archived payload integrity check failed');
  }
  return validatePayload(JSON.parse(raw.toString('utf8')));
}

// A tuple cursor bounds the raw index page before any eligibility joins. Keep
// microseconds as PostgreSQL text: pg's Date parser truncates them to milliseconds.
export const terminalModelCallArchivePageSql = `SELECT id,task_id,execution_id,finished_at::text AS cursor_finished_at
  FROM model_call_traces WHERE NOT payload_archived AND status<>'RUNNING' AND finished_at<$1
    AND (finished_at,execution_id,id)>($2::timestamptz,$3::uuid,$4::uuid)
  ORDER BY finished_at,execution_id,id LIMIT $5`;

export const terminalModelCallArchiveCandidateSql = `SELECT task.id AS task_id FROM tasks task
  WHERE task.id=ANY($1::bigint[]) AND NOT(task.id=ANY($5::bigint[])) AND EXISTS(
    SELECT 1 FROM model_call_traces call JOIN task_executions execution ON execution.id=call.execution_id
    WHERE call.id=ANY($2::uuid[]) AND call.task_id=task.id AND NOT call.payload_archived
      AND call.status<>'RUNNING' AND call.finished_at<$3
      AND execution.task_id=task.id AND execution.status<>'RUNNING' AND execution.finished_at<$3
      AND NOT(execution.id=ANY($4::uuid[]))
      AND NOT EXISTS(SELECT 1 FROM delivery_model_call_cleanup cleanup
        WHERE cleanup.task_id=task.id AND execution.id=ANY(cleanup.execution_ids)))
  ORDER BY array_position($1::bigint[],task.id) LIMIT 1 FOR UPDATE OF task SKIP LOCKED`;

async function readPendingPage(pool, cutoff, cursor, limit) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='5s'");
    // LIMIT alone cannot bound a sequential scan when only a few rows remain.
    // This maintenance-only transaction must walk the pending tuple index even
    // when deleted archive work has temporarily inflated its planner statistics.
    await client.query('SET LOCAL enable_seqscan=off');
    const page = (await client.query(terminalModelCallArchivePageSql,
      [cutoff, cursor.finishedAt, cursor.executionId, cursor.id, limit])).rows;
    await client.query('COMMIT'); return page;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

/** Terminal payloads stay available through detail reads. Recently ended calls
 * remain hot for debugging. Task -> execution -> call matches delivery locks. */
export async function drainTerminalModelCallPayloadArchive(pool, {
  limit = 10, batchSize = 20, retentionDays: days = 7, timeBudgetMs = 3000,
} = {}) {
  days = retentionDays(days);
  const cutoff = (await pool.query(`SELECT clock_timestamp()-($1*interval '1 day') AS cutoff`, [days])).rows[0].cutoff;
  const deadline = Date.now() + bounded(timeBudgetMs, 3000, 30_000);
  const visited = [];
  const batchLimit = bounded(limit, 10, 100);
  let cursor = cursors.get(pool) ?? firstCursor(), wrapped = false;
  let processed = 0, archived = 0, rawBytes = 0, compressedBytes = 0, scanned = 0;
  while (processed < batchLimit && scanned < 1000 && Date.now() < deadline) {
    const page = await readPendingPage(pool, cutoff, cursor, Math.min(100, 1000 - scanned));
    if (!page.length) {
      if (cursor.finishedAt === '-infinity' || wrapped) break;
      cursor = firstCursor(); cursors.set(pool, cursor); wrapped = true; continue;
    }
    scanned += page.length;
    const taskIds = [...new Set(page.map(row => row.task_id))], callIds = page.map(row => row.id);
    const executionIds = [...new Set(page.map(row => row.execution_id))], skippedTasks = [];
    while (processed < batchLimit && Date.now() < deadline) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL lock_timeout='500ms'");
      const candidate = (await client.query(terminalModelCallArchiveCandidateSql,
        [taskIds, callIds, cutoff, visited, skippedTasks])).rows[0];
      if (!candidate) { await client.query('COMMIT'); break; }
      const execution = (await client.query(`SELECT execution.id FROM task_executions execution
        WHERE execution.task_id=$1 AND execution.id=ANY($2::uuid[])
          AND NOT(execution.id=ANY($5::uuid[])) AND execution.status<>'RUNNING' AND execution.finished_at<$3
          AND EXISTS(SELECT 1 FROM model_call_traces call WHERE call.execution_id=execution.id
            AND call.id=ANY($4::uuid[]) AND NOT call.payload_archived AND call.status<>'RUNNING' AND call.finished_at<$3)
          AND NOT EXISTS(SELECT 1 FROM delivery_model_call_cleanup cleanup WHERE cleanup.task_id=$1
            AND execution.id=ANY(cleanup.execution_ids))
        ORDER BY array_position($2::uuid[],execution.id) LIMIT 1 FOR UPDATE OF execution SKIP LOCKED`,
      [candidate.task_id, executionIds, cutoff, callIds, visited])).rows[0];
      if (!execution) {
        await client.query('COMMIT'); skippedTasks.push(candidate.task_id); continue;
      }
      visited.push(execution.id);
      // Recheck after both locks. Delivery scheduling holds the same task lock.
      const captured = (await client.query(`SELECT EXISTS(SELECT 1 FROM delivery_model_call_cleanup
        WHERE task_id=$1 AND $2::uuid=ANY(execution_ids)) AS captured`,
      [candidate.task_id, execution.id])).rows[0].captured;
      if (captured) { await client.query('COMMIT'); continue; }
      const records = (await client.query(`WITH page AS MATERIALIZED (
        SELECT id,octet_length(prompt)+octet_length(request)+COALESCE(octet_length(response),0)
          +COALESCE(octet_length(error),0) AS payload_bytes FROM model_call_traces
        WHERE task_id=$1 AND execution_id=$2 AND NOT payload_archived
          AND status<>'RUNNING' AND finished_at<$3 ORDER BY id LIMIT $4
      ), bounded AS (
        SELECT id,sum(payload_bytes) OVER(ORDER BY id) AS bytes,row_number() OVER(ORDER BY id) AS ordinal FROM page
      ) SELECT call.id,call.prompt,call.request,call.response,call.error FROM model_call_traces call
        JOIN bounded ON bounded.id=call.id WHERE bounded.bytes<=8388608 OR bounded.ordinal=1
        ORDER BY call.id FOR UPDATE OF call SKIP LOCKED`,
      [candidate.task_id, execution.id, cutoff, bounded(batchSize, 20, 50)])).rows;
      let batchRawBytes = 0, batchCompressedBytes = 0;
      for (const record of records) {
        const encoded = await encodeModelCallPayload(record);
        await client.query(`INSERT INTO model_call_payload_archives(call_id,payload,raw_bytes,sha256)
          VALUES($1,$2,$3,$4)`, [record.id, encoded.payload, encoded.rawBytes, encoded.sha256]);
        await client.query(`UPDATE model_call_traces SET prompt='',request='',response=NULL,error=NULL,
          payload_archived=true WHERE id=$1`, [record.id]);
        batchRawBytes += encoded.rawBytes; batchCompressedBytes += encoded.payload.length;
      }
      await client.query('COMMIT');
      processed += 1; archived += records.length;
      rawBytes += batchRawBytes; compressedBytes += batchCompressedBytes;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
    }
    const last = page.at(-1);
    cursor = { finishedAt: last.cursor_finished_at, executionId: last.execution_id, id: last.id };
    cursors.set(pool, cursor);
  }
  return { processed, archived, rawBytes, compressedBytes, scanned };
}

/** Explicit maintenance reporting only; this scan is not part of each sweep. */
export async function readTerminalModelCallPayloadArchiveStats(pool, { retentionDays: days = 7 } = {}) {
  const result = await pool.query(`SELECT
    (SELECT count(*) FROM model_call_traces call JOIN task_executions execution ON execution.id=call.execution_id
      WHERE NOT call.payload_archived AND call.status<>'RUNNING' AND execution.status<>'RUNNING'
        AND execution.finished_at<clock_timestamp()-($1*interval '1 day')
        AND call.finished_at<clock_timestamp()-($1*interval '1 day')
        AND NOT EXISTS(SELECT 1 FROM delivery_model_call_cleanup cleanup
          WHERE cleanup.task_id=execution.task_id AND execution.id=ANY(cleanup.execution_ids)))::float8 AS "eligibleCalls",
    (SELECT count(*) FROM model_call_payload_archives)::float8 AS "archivedCalls",
    (SELECT COALESCE(sum(octet_length(prompt)+octet_length(request)
      +COALESCE(octet_length(response),0)+COALESCE(octet_length(error),0)),0)
      FROM model_call_traces WHERE NOT payload_archived)::float8 AS "hotBodyBytes",
    (SELECT COALESCE(sum(raw_bytes),0) FROM model_call_payload_archives)::float8 AS "rawBytes",
    (SELECT COALESCE(sum(octet_length(payload)),0) FROM model_call_payload_archives)::float8 AS "compressedBytes",
    pg_total_relation_size('model_call_payload_archives')::float8 AS "archiveTableBytes"`, [retentionDays(days)]);
  return result.rows[0];
}
