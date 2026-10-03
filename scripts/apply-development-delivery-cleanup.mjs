import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { developmentConfigurations } from './apply-development-scaling.mjs';
import { connectDatabase, isMain, quoteId, safeError } from '../server/scripts/database-common.mjs';
import { loadMigrations, pendingMigrations } from '../server/src/database-migrations.mjs';
import { exportDatabase } from '../server/scripts/export-database.mjs';
import { upgradeDatabase } from '../server/scripts/manage-database.mjs';
import { drainDeliveredCopyReviewDrafts } from '../server/src/delivery-draft-cleanup.mjs';
import { drainExpiredClaimReceipts } from '../server/src/claim-receipt-cleanup.mjs';

const reportPath = resolve('reports/delivery-disposable-cleanup-development.json');
const allowedMigration = '0113_remove_redundant_delivery_batch_index';

async function saveReport(report) {
  await mkdir(resolve('reports'), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}

async function productionFingerprint(config) {
  const client = connectDatabase(config);
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='60s'");
    const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
    assert.equal(database, 'xhs_control_prod');
    const readOnly = (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
    assert.equal(readOnly, 'on');
    const migrations = (await client.query('SELECT id,sha256 FROM control_plane_migrations ORDER BY id')).rows;
    const tables = (await client.query(`SELECT schemaname,tablename FROM pg_tables
      WHERE schemaname NOT LIKE 'pg_%' AND schemaname<>'information_schema'
      ORDER BY schemaname,tablename`)).rows;
    const fingerprints = [];
    for (const { schemaname, tablename } of tables) {
      const result = (await client.query(`SELECT count(*)::text AS count,
        coalesce(sum(hashtextextended(row_to_json(record)::text,0)::numeric),0)::text AS checksum
        FROM ${quoteId(schemaname)}.${quoteId(tablename)} record`)).rows[0];
      fingerprints.push({ schema: schemaname, table: tablename, ...result });
    }
    await client.query('COMMIT');
    return { database, readOnly, migrations, tables: fingerprints };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {}); throw error;
  } finally { await client.end(); }
}

// Counts only: no drafts, model text, execution snapshots or credentials enter the report.
async function developmentCounts(queryable) {
  const client = typeof queryable.release === 'function' ? queryable : await queryable.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='30s'");
    const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
    const drafts = (await client.query(`WITH evaluated AS (
        SELECT EXISTS(SELECT 1 FROM tasks task JOIN delivery_entries delivery
          ON delivery.task_id=task.id AND delivery.status='READY'
          AND delivery.copy_revision_id=task.current_copy_revision_id
          AND delivery.image_run_id=task.current_image_run_id
          WHERE task.id=draft.task_id AND task.state='REVIEWED' AND task.task_kind='CONTENT'
            AND NOT(task.input @> '{"testRun":true}'::jsonb)
            AND (task.image_qc_legacy_accepted OR EXISTS(
              SELECT 1 FROM image_approval_events approval
              WHERE approval.id=task.image_qc_released_approval_event_id
                AND approval.task_id=task.id
                AND approval.copy_revision_id=task.current_copy_revision_id
                AND approval.image_run_id=task.current_image_run_id))) AS eligible
        FROM copy_review_drafts draft
      ) SELECT count(*)::float8 AS total,count(*) FILTER(WHERE eligible)::float8 AS eligible,
        count(*) FILTER(WHERE NOT eligible)::float8 AS protected FROM evaluated`)).rows[0];
    const receipts = (await client.query(`WITH evaluated AS (
        SELECT expires_at,
          EXISTS(SELECT 1 FROM task_executions execution
            WHERE execution.id=ANY(receipt.execution_ids) AND execution.status='RUNNING') AS running
        FROM execution_claim_requests receipt
      ) SELECT count(*)::float8 AS total,
        count(*) FILTER(WHERE expires_at<=transaction_timestamp() AND NOT running)::float8 AS eligible,
        count(*) FILTER(WHERE expires_at IS NULL OR expires_at>transaction_timestamp() OR running)::float8 AS protected,
        count(*) FILTER(WHERE expires_at IS NULL)::float8 AS legacy,
        count(*) FILTER(WHERE expires_at>transaction_timestamp())::float8 AS "notExpired",
        count(*) FILTER(WHERE expires_at<=transaction_timestamp() AND running)::float8 AS "runningExpired"
      FROM evaluated`)).rows[0];
    const deliveryBatchIndexes = (await client.query(`SELECT indexname,indexdef FROM pg_indexes
      WHERE schemaname='public' AND tablename='delivery_batch_items' ORDER BY indexname`)).rows;
    await client.query('COMMIT');
    return { database, capturedAt: new Date().toISOString(), drafts, receipts, deliveryBatchIndexes };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {}); throw error;
  } finally { if (client !== queryable) client.release(); }
}

function assertProductionFingerprint(fingerprint) {
  assert.equal(fingerprint.database, 'xhs_control_prod');
  assert.equal(fingerprint.readOnly, 'on');
}

async function applyDevelopmentCleanup(dev, report) {
  const pool = new pg.Pool({ connectionString: dev.connectionString, max: 2, connectionTimeoutMillis: 10_000 });
  try {
    report.developmentBeforeApply = await developmentCounts(pool); await saveReport(report);
    assert.equal(report.developmentBeforeApply.database, 'xhs_control');
    const client = await pool.connect();
    try {
      const migrations = await loadMigrations();
      const pending = await pendingMigrations(client, migrations);
      report.pendingMigrations = pending.map(({ id, sha256 }) => ({ id, sha256 }));
      await saveReport(report);
      assert.ok(pending.every(migration => migration.id === allowedMigration), 'Unrelated pending migrations refused');
      report.applied = await upgradeDatabase(client, null, migrations); await saveReport(report);
      report.developmentMigrations = (await client.query('SELECT id,sha256 FROM control_plane_migrations ORDER BY id')).rows;
      await saveReport(report);
    } finally { client.release(); }
    report.cleanup = { startedAt: new Date().toISOString(), rounds: [], draftsDeleted: 0, receiptsDeleted: 0 };
    await saveReport(report);
    const deadline = Date.now() + 120_000;
    while (report.cleanup.rounds.length < 1000 && Date.now() < deadline) {
      const drafts = await drainDeliveredCopyReviewDrafts(pool, { limit: 20, batchSize: 200, maxDurationMs: 2000 });
      report.cleanup.rounds.push({ drafts }); report.cleanup.draftsDeleted += drafts.deleted;
      await saveReport(report);
      assert.ok(Number.isSafeInteger(drafts.deleted) && drafts.deleted >= 0, 'Invalid draft cleanup result');
      const receipts = await drainExpiredClaimReceipts(pool, { limit: 20, batchSize: 100, maxDurationMs: 2000 });
      report.cleanup.rounds.at(-1).receipts = receipts;
      report.cleanup.receiptsDeleted += receipts.deleted; await saveReport(report);
      assert.ok(Number.isSafeInteger(receipts.deleted) && receipts.deleted >= 0, 'Invalid receipt cleanup result');
      if (drafts.deleted === 0 && receipts.deleted === 0) {
        // A bounded draft page may contain only protected or currently locked
        // tasks while eligible drafts remain in a later page.
        const remaining = await developmentCounts(pool);
        report.cleanup.rounds.at(-1).remainingEligible = {
          drafts: remaining.drafts.eligible, receipts: remaining.receipts.eligible,
        };
        await saveReport(report);
        if (remaining.drafts.eligible === 0 && remaining.receipts.eligible === 0) break;
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
      }
    }
    report.cleanup.completedAt = new Date().toISOString();
    report.cleanup.stoppedAtBudget = Date.now() >= deadline || report.cleanup.rounds.length >= 1000;
    report.developmentAfter = await developmentCounts(pool);
    report.cleanup.remainingEligible = { drafts: report.developmentAfter.drafts.eligible,
      receipts: report.developmentAfter.receipts.eligible };
    report.cleanup.mayRetryLockedOrConcurrentRows = report.developmentAfter.drafts.eligible > 0 || report.developmentAfter.receipts.eligible > 0;
    await saveReport(report);
  } finally { await pool.end(); }
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.length === 1 && ['--backup-only', '--apply', '--verify-production'].includes(args[0]),
    'Use --backup-only, --apply or --verify-production');
  const { dev, prod } = developmentConfigurations();
  let report;
  try {
    if (args[0] === '--backup-only') {
      report = { createdAt: new Date().toISOString(), target: dev.display, developmentOnly: true,
        productionReadOnly: true, phase: 'STARTED' };
      await saveReport(report);
      report.productionBefore = await productionFingerprint(prod); await saveReport(report);
      assertProductionFingerprint(report.productionBefore);
      const pool = new pg.Pool({ connectionString: dev.connectionString, max: 1, connectionTimeoutMillis: 10_000 });
      let applied;
      try {
        report.developmentBefore = await developmentCounts(pool); await saveReport(report);
        assert.equal(report.developmentBefore.database, 'xhs_control');
        applied = (await pool.query('SELECT id FROM control_plane_migrations ORDER BY id')).rows.map(row => row.id);
      } finally { await pool.end(); }
      const migrations = (await loadMigrations()).filter(migration => applied.includes(migration.id));
      report.backup = await exportDatabase(dev, undefined, migrations);
      report.phase = 'BACKED_UP'; await saveReport(report);
      console.log(JSON.stringify({ target: dev.display, backup: report.backup,
        drafts: report.developmentBefore.drafts, receipts: report.developmentBefore.receipts, productionReadOnly: true }));
      return;
    }
    report = JSON.parse(await readFile(reportPath, 'utf8'));
    delete report.error; delete report.failedAt;
    report.requestedAction = args[0]; report.lastStartedAt = new Date().toISOString(); await saveReport(report);
    assert.equal(report.target, dev.display);
    assertProductionFingerprint(report.productionBefore);
    assert.ok(report.backup?.folder && report.backup.tables > 0, 'Create a development backup first');
    if (args[0] === '--apply') {
      const manifest = JSON.parse(await readFile(resolve(report.backup.folder, 'manifest.json'), 'utf8'));
      report.backupDatabase = manifest.databaseName; await saveReport(report);
      assert.equal(manifest.databaseName, 'xhs_control', 'Backup must belong to the development database');
      await applyDevelopmentCleanup(dev, report);
    }
    report.productionAfter = await productionFingerprint(prod);
    report.productionUnchanged = JSON.stringify(report.productionBefore) === JSON.stringify(report.productionAfter);
    report.completedAt = new Date().toISOString(); report.phase = 'VERIFIED'; await saveReport(report);
    assertProductionFingerprint(report.productionAfter);
    assert.ok(report.productionUnchanged, 'Production fingerprint changed; investigate concurrent activity before claiming unchanged');
    console.log(JSON.stringify({ target: dev.display, applied: report.applied,
      cleanup: report.cleanup && { draftsDeleted: report.cleanup.draftsDeleted, receiptsDeleted: report.cleanup.receiptsDeleted,
        remainingEligible: report.cleanup.remainingEligible }, productionUnchanged: true }));
  } catch (error) {
    const message = safeError(safeError(error, prod), dev);
    if (report) { report.phase = 'FAILED'; report.error = message; report.failedAt = new Date().toISOString(); await saveReport(report); }
    throw new Error(message);
  }
}

if (isMain(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
