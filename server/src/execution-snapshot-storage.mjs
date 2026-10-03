import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const components = Object.freeze([
  { key: 'prompts', column: 'snapshot_prompts_hash', result: 'promptsHash' },
  { key: 'knowledge', column: 'snapshot_knowledge_hash', result: 'knowledgeHash' },
  { key: 'productionSettings', column: 'snapshot_production_settings_hash', result: 'productionSettingsHash' },
]);

const backfillPredicate = `status <> 'RUNNING' AND content_cleared_at IS NULL AND (
  (snapshot_prompts_hash IS NULL AND snapshot->'prompts' IS NOT NULL AND snapshot->'prompts' <> 'null'::jsonb)
  OR (snapshot_knowledge_hash IS NULL AND snapshot->'knowledge' IS NOT NULL AND snapshot->'knowledge' <> 'null'::jsonb)
  OR (snapshot_production_settings_hash IS NULL AND snapshot->'productionSettings' IS NOT NULL
    AND snapshot->'productionSettings' <> 'null'::jsonb)
)`;

function jsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function orderedJson(value) {
  if (Array.isArray(value)) return value.map(orderedJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, orderedJson(value[key])]));
  }
  return value;
}

function contentHash(value) {
  return createHash('sha256').update(JSON.stringify(orderedJson(value))).digest('hex');
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function objectSnapshot(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function describeSnapshot(input) {
  // Use the same JSON representation as pg, preserving absent versus explicit null.
  const snapshot = jsonValue(input);
  const result = { snapshot, promptsHash: null, knowledgeHash: null, productionSettingsHash: null };
  if (!objectSnapshot(snapshot)) return { result, entries: [] };
  const unique = new Map();
  for (const { key, result: name } of components) {
    if (!Object.hasOwn(snapshot, key) || snapshot[key] === null) continue;
    const payload = snapshot[key];
    const sha256 = contentHash(payload);
    unique.set(sha256, { sha256, payload });
    result[name] = sha256;
    delete snapshot[key];
  }
  return { result, entries: [...unique.values()] };
}

async function storeSnapshotBatch(client, inputs) {
  const descriptions = inputs.map(describeSnapshot);
  const unique = new Map();
  for (const { entries } of descriptions) for (const entry of entries) {
    if (unique.has(entry.sha256) && !isDeepStrictEqual(unique.get(entry.sha256).payload, entry.payload)) {
      throw new Error(`Execution snapshot configuration hash collision: ${entry.sha256}`);
    }
    unique.set(entry.sha256, entry);
  }
  const results = descriptions.map(({ result }) => result);
  if (!unique.size) return { results, newContentBytes: 0 };
  // Sort the entire transaction's configuration batch, including distinct
  // retry configurations. Per-execution sorting can invert locks across rows.
  const entries = [...unique.values()].sort((left, right) => left.sha256.localeCompare(right.sha256));
  const inserted = (await client.query(`INSERT INTO execution_snapshot_contents(sha256,payload)
    SELECT content.sha256,content.payload
    FROM jsonb_to_recordset($1::jsonb) AS content(sha256 text,payload jsonb)
    ORDER BY content.sha256
    ON CONFLICT(sha256) DO NOTHING RETURNING sha256,payload`, [JSON.stringify(entries)])).rows;
  const stored = new Map(inserted.map(row => [row.sha256, row.payload]));
  const missing = entries.map(entry => entry.sha256).filter(hash => !stored.has(hash));
  if (missing.length) {
    for (const row of (await client.query('SELECT sha256,payload FROM execution_snapshot_contents WHERE sha256=ANY($1::varchar[])', [missing])).rows) {
      stored.set(row.sha256, row.payload);
    }
  }
  for (const { sha256, payload } of entries) {
    if (!stored.has(sha256) || !isDeepStrictEqual(stored.get(sha256), payload)) {
      throw new Error(`Execution snapshot configuration hash collision or missing content: ${sha256}`);
    }
  }
  return { results, newContentBytes: inserted.reduce((total, row) => total + jsonBytes(row.payload) + 64, 0) };
}

/** Caller owns the execution transaction; a failed claim rolls back its contents. */
export async function storeExecutionSnapshot(client, snapshot) {
  return (await storeSnapshotBatch(client, [snapshot])).results[0];
}

/** Claims/backfills sharing one transaction must prepare their whole batch first. */
export async function storeExecutionSnapshotBatch(client, snapshots) {
  return (await storeSnapshotBatch(client, snapshots)).results;
}

/** Restore complete snapshots in one content query without sharing mutable objects. */
export async function hydrateExecutionSnapshots(queryable, rows) {
  const hashes = [...new Set(rows.flatMap(row => components.map(({ column }) => row[column]).filter(Boolean)))];
  if (!hashes.length) return rows;
  const content = new Map();
  for (const row of (await queryable.query('SELECT sha256,payload FROM execution_snapshot_contents WHERE sha256=ANY($1::varchar[])', [hashes])).rows) {
    if (contentHash(row.payload) !== row.sha256) throw new Error(`Corrupt execution snapshot configuration content: ${row.sha256}`);
    content.set(row.sha256, row.payload);
  }
  return rows.map(row => {
    if (!components.some(({ column }) => row[column])) return row;
    if (!objectSnapshot(row.snapshot)) throw new Error('Referenced execution snapshot must be a JSON object');
    const snapshot = { ...row.snapshot };
    for (const { key, column } of components) {
      const hash = row[column];
      if (!hash) continue;
      if (!content.has(hash)) throw new Error(`Missing execution snapshot configuration content: ${hash}`);
      const payload = content.get(hash);
      if (Object.hasOwn(snapshot, key) && !isDeepStrictEqual(snapshot[key], payload)) {
        throw new Error(`Execution snapshot inline configuration conflicts with its reference: ${key}`);
      }
      snapshot[key] = structuredClone(payload);
    }
    return { ...row, snapshot };
  });
}

/** Only terminal executions are compacted; retries retain their captured config. */
export async function drainExecutionSnapshotBackfill(pool, { batchSize = 100, timeBudgetMs = 3000, maxBatches = 10 } = {}) {
  const limit = bounded(batchSize, 100, 500);
  const deadline = Date.now() + bounded(timeBudgetMs, 3000, 10_000);
  const batches = bounded(maxBatches, 10, 100);
  let processed = 0, logicalBytesSaved = 0;
  for (let batch = 0; batch < batches && Date.now() < deadline; batch++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL lock_timeout='250ms'");
      const rows = (await client.query(`SELECT * FROM task_executions
        WHERE ${backfillPredicate} ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
      if (!rows.length) { await client.query('COMMIT'); break; }
      const hydrated = await hydrateExecutionSnapshots(client, rows);
      const { results, newContentBytes } = await storeSnapshotBatch(client, hydrated.map(row => row.snapshot));
      let savedInBatch = -newContentBytes;
      for (let index = 0; index < hydrated.length; index++) {
        const row = hydrated[index], result = results[index];
        await client.query(`UPDATE task_executions SET snapshot=$2,
          snapshot_prompts_hash=$3,snapshot_knowledge_hash=$4,snapshot_production_settings_hash=$5
          WHERE id=$1`, [row.id, result.snapshot, result.promptsHash, result.knowledgeHash, result.productionSettingsHash]);
        const references = components.filter(({ result: name }) => result[name]).length * 64;
        savedInBatch += jsonBytes(row.snapshot) - jsonBytes(result.snapshot) - references;
      }
      await client.query('COMMIT');
      processed += rows.length;
      // Logical JSON/hash bytes exclude PostgreSQL row, TOAST and index overhead.
      logicalBytesSaved += savedInBatch;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return { processed, logicalBytesSaved };
}
