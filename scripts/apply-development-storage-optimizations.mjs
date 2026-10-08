import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import pg from 'pg';
import { developmentConfigurations } from './apply-development-scaling.mjs';
import { connectDatabase, isMain, quoteId, readBackup, safeError } from '../server/scripts/database-common.mjs';
import { loadMigrations, pendingMigrations } from '../server/src/database-migrations.mjs';
import { exportDatabase } from '../server/scripts/export-database.mjs';
import { upgradeDatabase } from '../server/scripts/manage-database.mjs';
import { drainExecutionSnapshotBackfill } from '../server/src/execution-snapshot-storage.mjs';
import { drainTerminalModelCallPayloadArchive, readTerminalModelCallPayloadArchiveStats } from '../server/src/model-call-payload-archive.mjs';
import { drainCopyReviewDraftArchive, readCopyReviewDraftArchiveStats } from '../server/src/copy-review-draft-archive.mjs';

const reportPath = resolve('reports/storage-optimizations-development.json');
const allowedMigrations = new Set(['0114_execution_snapshot_dedup',
  '0115_model_call_payload_archive', '0116_copy_review_draft_payload_archive']);
const storageTables = Object.freeze(['task_executions', 'execution_snapshot_contents',
  'model_call_traces', 'model_call_payload_archives', 'copy_review_drafts', 'copy_review_draft_payload_archives']);

async function saveReport(report) {
  await mkdir(resolve('reports'), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function productionFingerprint(config) {
  const client = connectDatabase(config);
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='60s'");
    const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
    const readOnly = (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
    assert.equal(database, 'xhs_control_prod'); assert.equal(readOnly, 'on');
    const migrations = (await client.query('SELECT id,sha256 FROM control_plane_migrations ORDER BY id')).rows;
    const tables = (await client.query(`SELECT schemaname,tablename FROM pg_tables
      WHERE schemaname NOT LIKE 'pg_%' AND schemaname<>'information_schema'
      ORDER BY schemaname,tablename`)).rows;
    const fingerprints = [];
    for (const { schemaname, tablename } of tables) {
      const row = (await client.query(`SELECT count(*)::text AS count,
        coalesce(sum(hashtextextended(row_to_json(record)::text,0)::numeric),0)::text AS checksum
        FROM ${quoteId(schemaname)}.${quoteId(tablename)} record`)).rows[0];
      fingerprints.push({ schema: schemaname, table: tablename, ...row });
    }
    await client.query('COMMIT');
    return { database, readOnly, migrations, tables: fingerprints };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { await client.end(); }
}

function assertProductionFingerprint(fingerprint) {
  assert.equal(fingerprint?.database, 'xhs_control_prod'); assert.equal(fingerprint?.readOnly, 'on');
  assert.ok(Array.isArray(fingerprint.tables) && fingerprint.tables.length > 0);
}

async function readSnapshotStats(client, compactSchema) {
  const eligibility = ['prompts', 'knowledge', 'productionSettings'].map((key, index) => {
    const hash = ['snapshot_prompts_hash', 'snapshot_knowledge_hash', 'snapshot_production_settings_hash'][index];
    return `(${compactSchema ? `${hash} IS NULL AND ` : ''}snapshot->'${key}' IS NOT NULL
      AND snapshot->'${key}'<>'null'::jsonb)`;
  }).join(' OR ');
  const row = (await client.query(`SELECT count(*)::float8 AS "totalExecutions",
    count(*) FILTER(WHERE status='RUNNING')::float8 AS "protectedRunning",
    count(*) FILTER(WHERE status<>'RUNNING' AND content_cleared_at IS NULL AND (${eligibility}))::float8 AS "eligibleExecutions",
    COALESCE(sum(octet_length(snapshot::text)),0)::float8 AS "hotJsonBytes"
    ${compactSchema ? `,count(*) FILTER(WHERE snapshot_prompts_hash IS NOT NULL
      OR snapshot_knowledge_hash IS NOT NULL OR snapshot_production_settings_hash IS NOT NULL)::float8 AS "compactedExecutions",
      COALESCE(sum((CASE WHEN snapshot_prompts_hash IS NOT NULL THEN 64 ELSE 0 END)
        +(CASE WHEN snapshot_knowledge_hash IS NOT NULL THEN 64 ELSE 0 END)
        +(CASE WHEN snapshot_production_settings_hash IS NOT NULL THEN 64 ELSE 0 END)),0)::float8 AS "referenceBytes"` : ''}
    FROM task_executions`)).rows[0];
  if (!compactSchema) return { ...row, compactedExecutions: 0, uniqueContents: 0, referenceBytes: 0,
    uniqueContentJsonBytes: 0, logicalStorageBytes: row.hotJsonBytes, logicalRestoredJsonBytes: row.hotJsonBytes };
  const contents = (await client.query(`SELECT count(*)::float8 AS "uniqueContents",
    COALESCE(sum(octet_length(payload::text)),0)::float8 AS "uniqueContentJsonBytes" FROM execution_snapshot_contents`)).rows[0];
  const restored = (await client.query(`SELECT COALESCE(sum(octet_length((CASE
    WHEN prompts.sha256 IS NULL AND knowledge.sha256 IS NULL AND settings.sha256 IS NULL THEN execution.snapshot
    ELSE execution.snapshot
    ||CASE WHEN prompts.sha256 IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('prompts',prompts.payload) END
    ||CASE WHEN knowledge.sha256 IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('knowledge',knowledge.payload) END
    ||CASE WHEN settings.sha256 IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('productionSettings',settings.payload) END
    END)::text)),0)::float8 AS "logicalRestoredJsonBytes"
    FROM task_executions execution
    LEFT JOIN execution_snapshot_contents prompts ON prompts.sha256=execution.snapshot_prompts_hash
    LEFT JOIN execution_snapshot_contents knowledge ON knowledge.sha256=execution.snapshot_knowledge_hash
    LEFT JOIN execution_snapshot_contents settings ON settings.sha256=execution.snapshot_production_settings_hash`)).rows[0];
  return { ...row, ...contents, ...restored,
    logicalStorageBytes: row.hotJsonBytes + row.referenceBytes + contents.uniqueContentJsonBytes };
}

async function readModelStats(client, compactSchema) {
  const max = (await client.query(`SELECT COALESCE(max(octet_length(prompt)+octet_length(request)
    +COALESCE(octet_length(response),0)+COALESCE(octet_length(error),0)),0)::float8 AS "maxHotBodyBytes",
    count(*)::float8 AS "totalCalls" FROM model_call_traces`)).rows[0];
  if (compactSchema) return { ...await readTerminalModelCallPayloadArchiveStats(client), ...max };
  const row = (await client.query(`SELECT count(*) FILTER(WHERE call.status<>'RUNNING'
      AND execution.status<>'RUNNING' AND execution.finished_at<transaction_timestamp()-interval '7 days'
      AND call.finished_at<transaction_timestamp()-interval '7 days'
      AND NOT EXISTS(SELECT 1 FROM delivery_model_call_cleanup cleanup
        WHERE cleanup.task_id=execution.task_id AND execution.id=ANY(cleanup.execution_ids)))::float8 AS "eligibleCalls",
    COALESCE(sum(octet_length(call.prompt)+octet_length(call.request)+COALESCE(octet_length(call.response),0)
      +COALESCE(octet_length(call.error),0)),0)::float8 AS "hotBodyBytes"
    FROM model_call_traces call JOIN task_executions execution ON execution.id=call.execution_id`)).rows[0];
  return { ...row, ...max, archivedCalls: 0, rawBytes: 0, compressedBytes: 0, archiveTableBytes: 0 };
}

async function readDraftStats(client, compactSchema) {
  const max = (await client.query(`SELECT COALESCE(max(octet_length(content::text)),0)::float8 AS "maxHotBodyBytes"
    FROM copy_review_drafts`)).rows[0];
  if (compactSchema) return { ...await readCopyReviewDraftArchiveStats(client), ...max };
  const row = (await client.query(`SELECT count(*)::float8 AS "totalDrafts",
    count(*) FILTER(WHERE NOT(task.state='COPY_REVIEW_PENDING'
      AND draft.base_copy_revision_id IS NOT DISTINCT FROM task.current_copy_revision_id))::float8 AS "eligibleDrafts",
    count(*) FILTER(WHERE task.state='COPY_REVIEW_PENDING'
      AND draft.base_copy_revision_id IS NOT DISTINCT FROM task.current_copy_revision_id)::float8 AS "protectedDrafts",
    COALESCE(sum(octet_length(draft.content::text)),0)::float8 AS "hotBodyBytes"
    FROM copy_review_drafts draft JOIN tasks task ON task.id=draft.task_id`)).rows[0];
  return { ...row, ...max, archivedDrafts: 0, archiveBytes: 0, archivedOriginalBytes: 0 };
}

// Reports contain counts, sizes and checksums only. No application body or DB URL.
async function developmentStats(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='60s'");
    const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
    assert.equal(database, 'xhs_control');
    const schema = (await client.query(`SELECT
      to_regclass('public.execution_snapshot_contents') IS NOT NULL AS snapshot,
      to_regclass('public.model_call_payload_archives') IS NOT NULL AS model,
      to_regclass('public.copy_review_draft_payload_archives') IS NOT NULL AS draft`)).rows[0];
    const snapshots = await readSnapshotStats(client, schema.snapshot);
    const modelCalls = await readModelStats(client, schema.model);
    const drafts = await readDraftStats(client, schema.draft);
    const physicalTables = (await client.query(`SELECT table_name AS name,
      pg_total_relation_size(to_regclass('public.'||quote_ident(table_name)))::float8 AS "totalBytes",
      pg_relation_size(to_regclass('public.'||quote_ident(table_name)))::float8 AS "heapBytes",
      pg_indexes_size(to_regclass('public.'||quote_ident(table_name)))::float8 AS "indexBytes"
      FROM unnest($1::text[]) AS tables(table_name) WHERE to_regclass('public.'||quote_ident(table_name)) IS NOT NULL
      ORDER BY table_name`, [storageTables])).rows;
    await client.query('COMMIT');
    return { database, capturedAt: new Date().toISOString(), schema, snapshots, modelCalls, drafts, physicalTables,
      logicalByteDefinition: 'JSON text plus reference hashes and compressed bodies; PostgreSQL rows/TOAST/index overhead excluded' };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

/** Hold the port for the entire apply so old centers cannot start mid-backfill. */
export async function holdStoppedDevelopmentPort(port = 4311) {
  const servers = [];
  const addresses = [];
  const listen = async (host, ipv6Only) => {
    const server = createServer(socket => socket.destroy());
    await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen({ host, port, exclusive: true, ipv6Only }, () => {
      server.removeListener('error', rejectListen); resolveListen();
    });
    });
    servers.push(server);
    addresses.push(host);
  };
  const close = async () => {
    for (const server of servers) await new Promise(resolveClose => server.close(resolveClose));
  };
  // Windows can allow wildcard and loopback listeners to coexist. Reserve both
  // exact addresses in each protocol; other platforms' wildcards cover loopback.
  try {
    if (process.platform === 'win32') await listen('127.0.0.1', false);
    await listen('0.0.0.0', false);
    try {
      if (process.platform === 'win32') await listen('::1', true);
      await listen('::', true);
    }
    catch (error) { if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) throw error; }
  }
  catch (error) {
    await close();
    throw new Error(`Stop the development center listening on port ${port} before applying storage optimizations`, { cause: error });
  }
  return { evidence: { port, previousListenerAbsent: true, heldDuringApply: true,
    reservedAddresses: addresses,
    checkedAt: new Date().toISOString() }, close };
}

function eligible(stats) {
  return { snapshots: stats.snapshots.eligibleExecutions, modelCalls: stats.modelCalls.eligibleCalls,
    drafts: stats.drafts.eligibleDrafts };
}

function noEligible(stats) { return Object.values(eligible(stats)).every(count => count === 0); }

async function applyDevelopmentStorage(dev, report) {
  const portGuard = await holdStoppedDevelopmentPort();
  const pool = new pg.Pool({ connectionString: dev.connectionString, max: 2, connectionTimeoutMillis: 10_000 });
  try {
    report.developmentServiceStopped = portGuard.evidence; await saveReport(report);
    report.developmentBeforeApply = await developmentStats(pool); await saveReport(report);
    // Current uploader limits are below these ceilings. Reject unexpectedly large
    // legacy bodies before changing schema rather than dropping their contents.
    assert.ok(report.developmentBeforeApply.modelCalls.maxHotBodyBytes < 8388096, 'Legacy model body exceeds the archive safety bound');
    assert.ok(report.developmentBeforeApply.drafts.maxHotBodyBytes <= 1048576, 'Legacy review draft exceeds the archive safety bound');
    const client = await pool.connect();
    try {
      assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, 'xhs_control');
      const migrations = await loadMigrations(), pending = await pendingMigrations(client, migrations);
      report.pendingMigrations = pending.map(({ id, sha256 }) => ({ id, sha256 })); await saveReport(report);
      assert.ok(pending.every(migration => allowedMigrations.has(migration.id)), 'Unrelated pending migrations refused');
      report.applied = await upgradeDatabase(client, null, migrations); await saveReport(report);
      report.developmentMigrations = (await client.query('SELECT id,sha256 FROM control_plane_migrations ORDER BY id')).rows;
      await saveReport(report);
    } finally { client.release(); }
    report.cleanup ??= { snapshotsProcessed: 0, modelCallsArchived: 0, draftsArchived: 0,
      snapshotLogicalBytesSaved: 0, modelRawBytes: 0, modelCompressedBytes: 0, draftLogicalBytesSaved: 0, rounds: [] };
    const attempt = { startedAt: new Date().toISOString(), firstRound: report.cleanup.rounds.length };
    (report.applyAttempts ??= []).push(attempt); await saveReport(report);
    const deadline = Date.now() + 300_000;
    for (let index = 0; index < 1000 && Date.now() < deadline; index += 1) {
      const round = { index: report.cleanup.rounds.length + 1, startedAt: new Date().toISOString() };
      report.cleanup.rounds.push(round);
      round.snapshots = await drainExecutionSnapshotBackfill(pool, { batchSize: 100, maxBatches: 10, timeBudgetMs: 2000 });
      assert.ok(Number.isSafeInteger(round.snapshots.processed) && round.snapshots.processed >= 0);
      report.cleanup.snapshotsProcessed += round.snapshots.processed;
      report.cleanup.snapshotLogicalBytesSaved += round.snapshots.logicalBytesSaved; await saveReport(report);
      round.modelCalls = await drainTerminalModelCallPayloadArchive(pool, { limit: 20, batchSize: 20, timeBudgetMs: 2000 });
      assert.ok(Number.isSafeInteger(round.modelCalls.archived) && round.modelCalls.archived >= 0);
      report.cleanup.modelCallsArchived += round.modelCalls.archived;
      report.cleanup.modelRawBytes += round.modelCalls.rawBytes;
      report.cleanup.modelCompressedBytes += round.modelCalls.compressedBytes; await saveReport(report);
      round.drafts = await drainCopyReviewDraftArchive(pool, { batchSize: 50, maxBatches: 10, timeBudgetMs: 2000 });
      assert.ok(Number.isSafeInteger(round.drafts.processed) && round.drafts.processed >= 0);
      report.cleanup.draftsArchived += round.drafts.processed;
      report.cleanup.draftLogicalBytesSaved += round.drafts.logicalBytesSaved; await saveReport(report);
      if (round.snapshots.processed === 0 && round.modelCalls.archived === 0 && round.drafts.processed === 0) {
        const remaining = await developmentStats(pool); round.remainingEligible = eligible(remaining); await saveReport(report);
        if (noEligible(remaining)) break;
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
      }
    }
    report.developmentAfter = await developmentStats(pool);
    report.cleanup.remainingEligible = eligible(report.developmentAfter);
    report.cleanup.complete = noEligible(report.developmentAfter);
    report.cleanup.stoppedAtBudget = !report.cleanup.complete;
    attempt.completedAt = new Date().toISOString(); attempt.lastRound = report.cleanup.rounds.length;
    report.logicalComparison = {
      snapshotBytesSaved: report.developmentBefore.snapshots.logicalStorageBytes - report.developmentAfter.snapshots.logicalStorageBytes,
      modelBodyBytesSaved: report.developmentBefore.modelCalls.hotBodyBytes + report.developmentBefore.modelCalls.compressedBytes
        - report.developmentAfter.modelCalls.hotBodyBytes
        - report.developmentAfter.modelCalls.compressedBytes,
      draftBodyBytesSaved: report.developmentBefore.drafts.hotBodyBytes + report.developmentBefore.drafts.archiveBytes
        - report.developmentAfter.drafts.hotBodyBytes
        - report.developmentAfter.drafts.archiveBytes,
      physicalFilesMayRemainAllocated: true,
    };
    await saveReport(report);
  } finally { try { await pool.end(); } finally { await portGuard.close(); } }
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.length === 1 && ['--backup-only', '--apply', '--verify-production'].includes(args[0]),
    'Use --backup-only, --apply or --verify-production');
  const { dev, prod } = developmentConfigurations();
  let report;
  try {
    if (args[0] === '--backup-only') {
      report = { createdAt: new Date().toISOString(), target: dev.display,
        developmentOnly: true, productionReadOnly: true, phase: 'STARTED' };
      await saveReport(report);
      report.productionBefore = await productionFingerprint(prod); assertProductionFingerprint(report.productionBefore); await saveReport(report);
      const pool = new pg.Pool({ connectionString: dev.connectionString, max: 1, connectionTimeoutMillis: 10_000 });
      let applied;
      try {
        report.developmentBefore = await developmentStats(pool); await saveReport(report);
        applied = (await pool.query('SELECT id FROM control_plane_migrations ORDER BY id')).rows.map(row => row.id);
      } finally { await pool.end(); }
      const migrations = (await loadMigrations()).filter(migration => applied.includes(migration.id));
      report.backup = await exportDatabase(dev, undefined, migrations);
      const backup = await readBackup(report.backup.folder);
      assert.equal(backup.manifest.databaseName, 'xhs_control');
      report.backupValidatedAt = new Date().toISOString(); report.backupCreatedAt = backup.manifest.createdAt;
      report.phase = 'BACKED_UP'; await saveReport(report);
      console.log(JSON.stringify({ target: dev.display, backup: report.backup,
        eligible: eligible(report.developmentBefore), productionReadOnly: true })); return;
    }
    report = JSON.parse(await readFile(reportPath, 'utf8'));
    delete report.error; delete report.failedAt;
    report.requestedAction = args[0]; report.lastStartedAt = new Date().toISOString(); await saveReport(report);
    assert.equal(report.target, dev.display); assertProductionFingerprint(report.productionBefore);
    assert.ok(report.backup?.folder && report.backup.tables > 0, 'Create a fresh development backup first');
    if (args[0] === '--apply') {
      const backup = await readBackup(report.backup.folder);
      assert.equal(backup.manifest.databaseName, 'xhs_control', 'Backup must belong to the development database');
      const age = Date.now() - Date.parse(backup.manifest.createdAt);
      assert.ok(Number.isFinite(age) && age >= 0 && age <= 86400_000, 'Create a fresh development backup within 24 hours');
      report.backupValidatedAt = new Date().toISOString(); await saveReport(report);
      await applyDevelopmentStorage(dev, report);
    }
    report.productionAfter = await productionFingerprint(prod); assertProductionFingerprint(report.productionAfter);
    report.productionUnchanged = JSON.stringify(report.productionBefore) === JSON.stringify(report.productionAfter);
    const incomplete = report.cleanup && !report.cleanup.complete;
    report.completedAt = new Date().toISOString();
    report.phase = incomplete ? 'BACKFILL_PENDING' : 'VERIFIED'; await saveReport(report);
    assert.ok(report.productionUnchanged, 'Production fingerprint changed; investigate concurrent activity before claiming unchanged');
    if (args[0] === '--apply' && !report.cleanup.complete) {
      report.backfillPending = true; await saveReport(report);
      throw new Error('Eligible development rows remain after the bounded run; use --apply again to resume safely');
    }
    if (!incomplete) delete report.backfillPending;
    await saveReport(report);
    console.log(JSON.stringify({ target: dev.display, applied: report.applied,
      cleanup: report.cleanup && { snapshotsProcessed: report.cleanup.snapshotsProcessed,
        modelCallsArchived: report.cleanup.modelCallsArchived, draftsArchived: report.cleanup.draftsArchived,
        remainingEligible: report.cleanup.remainingEligible, complete: report.cleanup.complete }, productionUnchanged: true }));
  } catch (error) {
    const message = safeError(safeError(error, prod), dev);
    if (report) {
      report.phase = 'FAILED'; report.error = message; report.failedAt = new Date().toISOString();
      if (report.backup) {
        const failurePool = new pg.Pool({ connectionString: dev.connectionString, max: 1, connectionTimeoutMillis: 10_000 });
        try { report.developmentAfterFailure = await developmentStats(failurePool); }
        catch (metricsError) { report.developmentMetricsError = safeError(safeError(metricsError, prod), dev); }
        finally { await failurePool.end(); }
      }
      if (report.productionBefore) {
        try {
          report.productionAfterFailure = await productionFingerprint(prod);
          report.productionUnchangedAfterFailure = JSON.stringify(report.productionBefore) === JSON.stringify(report.productionAfterFailure);
        } catch (verificationError) { report.productionVerificationError = safeError(safeError(verificationError, prod), dev); }
      }
      await saveReport(report);
    }
    throw new Error(message);
  }
}

if (isMain(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
