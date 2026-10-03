import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip as gzipCallback, gunzip as gunzipCallback } from 'node:zlib';

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);
const MAX_BODY_BYTES = 1024 * 1024;
const cursors = new WeakMap();

const INACTIVE_DRAFT_SQL = `NOT (task.state='COPY_REVIEW_PENDING'
  AND draft.base_copy_revision_id IS NOT DISTINCT FROM task.current_copy_revision_id)`;

function bounded(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Archived copy review draft content is invalid');
  }
}

export async function encodeCopyReviewDraftContent(content) {
  assertObject(content);
  const bytes = Buffer.from(JSON.stringify(content), 'utf8');
  if (bytes.length > MAX_BODY_BYTES) throw new Error('Copy review draft exceeds the archive size limit');
  return {
    codec: 'gzip', payload: await gzip(bytes),
    original_byte_length: bytes.length, sha256: digest(bytes),
  };
}

export async function decodeCopyReviewDraftContent(archive) {
  const expectedLength = Number(archive?.original_byte_length);
  if (archive?.codec !== 'gzip' || !Buffer.isBuffer(archive.payload)
      || archive.payload.length < 1 || archive.payload.length > 1100000
      || !Number.isSafeInteger(expectedLength) || expectedLength < 2 || expectedLength > MAX_BODY_BYTES
      || !/^[a-f0-9]{64}$/u.test(archive.sha256 ?? '')) {
    throw new Error('Copy review draft archive metadata is invalid');
  }
  const bytes = await gunzip(archive.payload, { maxOutputLength: MAX_BODY_BYTES });
  if (bytes.length !== expectedLength || digest(bytes) !== archive.sha256) {
    throw new Error('Copy review draft archive integrity check failed');
  }
  const content = JSON.parse(bytes.toString('utf8'));
  assertObject(content);
  return content;
}

/** Preserve IDs, ownership and optimistic versions when an old client reads cold content. */
export async function hydrateCopyReviewDrafts(queryable, rows) {
  const archivedRows = rows.filter(row => row.content_archived_at != null);
  if (!archivedRows.length) return rows;
  const archives = (await queryable.query(`
    SELECT draft_id,codec,payload,original_byte_length,sha256
    FROM copy_review_draft_payload_archives WHERE draft_id=ANY($1::bigint[])
  `, [archivedRows.map(row => row.id)])).rows;
  const byId = new Map(archives.map(archive => [String(archive.draft_id), archive]));
  return Promise.all(rows.map(async row => {
    if (row.content_archived_at == null) return row;
    const archive = byId.get(String(row.id));
    if (!archive) throw new Error('Copy review draft archive is missing');
    return { ...row, content: await decodeCopyReviewDraftContent(archive) };
  }));
}

/** Task locks serialize archival with draft saves, rework and delivery deletion. */
export async function drainCopyReviewDraftArchive(pool, {
  batchSize = 50, timeBudgetMs = 2000, maxBatches = 10,
} = {}) {
  const rowLimit = bounded(batchSize, 50, 200);
  const batchLimit = bounded(maxBatches, 10, 50);
  const deadline = Date.now() + bounded(timeBudgetMs, 2000, 5000);
  const scanLimit = batchLimit * 100;
  const visited = [];
  let cursor = cursors.get(pool) ?? '0';
  let wrapped = false, batches = 0, processed = 0, logicalBytesSaved = 0;
  while (batches < batchLimit && visited.length < scanLimit && Date.now() < deadline) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='2s'");
      await client.query("SET LOCAL lock_timeout='250ms'");
      const page = (await client.query(`SELECT id,task_id FROM copy_review_drafts
        WHERE content_archived_at IS NULL AND id>$1 AND NOT(id=ANY($2::bigint[]))
        ORDER BY id LIMIT $3`, [cursor, visited, Math.min(100, scanLimit - visited.length)])).rows;
      if (!page.length) {
        await client.query('COMMIT');
        if (cursor === '0' || wrapped) break;
        cursor = '0'; wrapped = true;
        continue;
      }
      const pageIds = page.map(row => row.id);
      const taskIds = [...new Set(page.map(row => row.task_id))];
      const candidate = (await client.query(`SELECT task.id FROM tasks task
        WHERE task.id=ANY($1::bigint[]) AND EXISTS(
          SELECT 1 FROM copy_review_drafts draft WHERE draft.task_id=task.id
            AND draft.id=ANY($2::bigint[]) AND draft.content_archived_at IS NULL
            AND ${INACTIVE_DRAFT_SQL})
        ORDER BY array_position($1::bigint[],task.id) LIMIT 1 FOR UPDATE OF task SKIP LOCKED`,
      [taskIds, pageIds])).rows[0];
      if (!candidate) {
        await client.query('COMMIT');
        cursor = String(page.at(-1).id); cursors.set(pool, cursor); visited.push(...pageIds);
        continue;
      }
      // Fresh READ COMMITTED statement after taking the task lock protects a
      // revision restored to active review while the candidate page was read.
      const drafts = (await client.query(`SELECT draft.* FROM copy_review_drafts draft
        JOIN tasks task ON task.id=draft.task_id WHERE task.id=$1
          AND draft.content_archived_at IS NULL AND ${INACTIVE_DRAFT_SQL}
        ORDER BY draft.id LIMIT $2 FOR UPDATE OF draft`, [candidate.id, rowLimit])).rows;
      const encoded = await Promise.all(drafts.map(async draft => ({
        draft, archive: await encodeCopyReviewDraftContent(draft.content),
      })));
      for (const { draft, archive } of encoded) {
        await client.query(`INSERT INTO copy_review_draft_payload_archives(
          draft_id,codec,payload,original_byte_length,sha256) VALUES ($1,$2,$3,$4,$5)`,
        [draft.id, archive.codec, archive.payload, archive.original_byte_length, archive.sha256]);
        await client.query(`UPDATE copy_review_drafts SET content='{}'::jsonb,
          content_archived_at=now() WHERE id=$1`, [draft.id]);
      }
      await client.query('COMMIT');
      processed += encoded.length; batches += 1;
      for (const { archive } of encoded) logicalBytesSaved += archive.original_byte_length - archive.payload.length;
      const candidatePage = page.filter(row => String(row.task_id) === String(candidate.id));
      cursor = String(candidatePage.at(-1).id); cursors.set(pool, cursor);
      visited.push(...pageIds.filter(id => BigInt(id) <= BigInt(cursor)));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return { processed, logicalBytesSaved };
}

/** Intended for explicit maintenance reports, not frequent UI polling. */
export async function readCopyReviewDraftArchiveStats(queryable) {
  const [drafts, archives] = await Promise.all([
    queryable.query(`SELECT count(*) AS total_drafts,
      count(*) FILTER (WHERE draft.content_archived_at IS NOT NULL) AS archived_drafts,
      count(*) FILTER (WHERE draft.content_archived_at IS NULL AND ${INACTIVE_DRAFT_SQL}) AS eligible_drafts,
      count(*) FILTER (WHERE NOT (${INACTIVE_DRAFT_SQL})) AS protected_drafts,
      COALESCE(sum(octet_length(draft.content::text)) FILTER(WHERE draft.content_archived_at IS NULL),0) AS hot_body_bytes
      FROM copy_review_drafts draft JOIN tasks task ON task.id=draft.task_id`),
    queryable.query(`SELECT COALESCE(sum(octet_length(payload)),0) AS archive_bytes,
      COALESCE(sum(original_byte_length),0) AS archived_original_bytes
      FROM copy_review_draft_payload_archives`),
  ]);
  const row = { ...drafts.rows[0], ...archives.rows[0] };
  return {
    totalDrafts: Number(row.total_drafts), archivedDrafts: Number(row.archived_drafts),
    eligibleDrafts: Number(row.eligible_drafts), protectedDrafts: Number(row.protected_drafts),
    hotBodyBytes: Number(row.hot_body_bytes), archiveBytes: Number(row.archive_bytes),
    archivedOriginalBytes: Number(row.archived_original_bytes),
  };
}
