export const MAINTENANCE_TABLES = Object.freeze([
  'tasks', 'assets', 'model_call_traces', 'operator_performance_events', 'operator_stage_current',
  'task_assignment_events', 'task_assignment_records', 'copy_revisions', 'image_runs',
  'copy_review_drafts', 'execution_claim_requests', 'task_executions', 'execution_snapshot_contents',
  'model_call_payload_archives', 'copy_review_draft_payload_archives',
  'image_edit_requests', 'quality_inspection_links', 'task_report_exports',
  'report_projection_tasks', 'report_operator_event_context', 'report_annotation_assignment_history', 'report_fact_versions',
]);

/** Counts are PostgreSQL estimates, not an expensive application-data scan. */
export async function readDatabaseMaintenanceMetrics(client) {
  const tables = (await client.query(`SELECT s.relname AS name,s.n_live_tup::text AS live_rows,
    s.n_dead_tup::text AS dead_rows,s.n_mod_since_analyze::text AS changes_since_analyze,
    s.last_vacuum,s.last_autovacuum,s.last_analyze,s.last_autoanalyze,
    s.vacuum_count::text,s.autovacuum_count::text,s.analyze_count::text,s.autoanalyze_count::text,
    age(c.relfrozenxid)::text AS xid_age,c.reloptions,
    pg_total_relation_size(c.oid)::text AS total_bytes,pg_relation_size(c.oid)::text AS table_bytes,
    pg_indexes_size(c.oid)::text AS index_bytes
    FROM pg_stat_user_tables s JOIN pg_class c ON c.oid=s.relid
    WHERE s.schemaname='public' AND s.relname=ANY($1::text[]) ORDER BY s.relname`, [MAINTENANCE_TABLES])).rows;
  const database = (await client.query(`SELECT current_database() AS name,numbackends,
    xact_commit::text,xact_rollback::text,deadlocks::text,temp_files::text,temp_bytes::text,stats_reset,
    blks_hit::text,blks_read::text FROM pg_stat_database WHERE datname=current_database()`)).rows[0];
  const sessions = (await client.query(`SELECT count(*) FILTER(WHERE state='active')::integer AS active,
    count(*) FILTER(WHERE state='idle in transaction')::integer AS idle_in_transaction,
    count(*) FILTER(WHERE wait_event_type='Lock')::integer AS waiting_for_lock,
    max(EXTRACT(epoch FROM clock_timestamp()-xact_start)) FILTER(WHERE xact_start IS NOT NULL) AS oldest_transaction_seconds
    FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`)).rows[0];
  const settings = (await client.query(`SELECT name,setting,unit FROM pg_settings WHERE name IN
    ('autovacuum','autovacuum_max_workers','autovacuum_vacuum_scale_factor','autovacuum_analyze_scale_factor',
     'autovacuum_vacuum_threshold','autovacuum_analyze_threshold','autovacuum_freeze_max_age','track_counts') ORDER BY name`)).rows;
  return { capturedAt: new Date().toISOString(), estimates: true, database, sessions, settings, tables,
    recommendations: recommendTableMaintenance(tables) };
}

export function recommendTableMaintenance(tables) {
  return tables.flatMap(table => {
    const live = Number(table.live_rows), dead = Number(table.dead_rows), changes = Number(table.changes_since_analyze);
    const vacuum = dead >= Math.max(1000, live * 0.02) || Number(table.xid_age) >= 150_000_000;
    const analyze = changes >= Math.max(1000, live * 0.05) || live > 0 && !table.last_analyze && !table.last_autoanalyze;
    return vacuum || analyze ? [{ table: table.name, action: vacuum ? 'VACUUM_ANALYZE' : 'ANALYZE',
      deadRows: dead, changesSinceAnalyze: changes }] : [];
  });
}

/** Explicit named tables only. No FULL, instance settings or scheduler. */
export async function maintainDatabaseTables(client, metrics, { tables, tuneAutovacuum = false } = {}) {
  if (!Array.isArray(tables) || !tables.length || new Set(tables).size !== tables.length
    || tables.some(table => !MAINTENANCE_TABLES.includes(table)
      || !metrics.tables.some(row => row.name === table))) throw new TypeError('Choose existing allowed tables explicitly');
  const lock = (await client.query('SELECT pg_try_advisory_lock(7311,111) AS locked')).rows[0]?.locked;
  if (!lock) throw new Error('A development maintenance operation is already running');
  const changed = [];
  try {
    await client.query("SET statement_timeout='120s'");
    await client.query("SET lock_timeout='1s'");
    await client.query("SET vacuum_cost_delay='5ms'");
    for (const table of tables) {
      const name = `public."${table}"`;
      const recommendation = metrics.recommendations.find(row => row.table === table);
      if (tuneAutovacuum) {
        await client.query(`ALTER TABLE ${name} SET (autovacuum_enabled=true,
          autovacuum_vacuum_scale_factor=0.02,autovacuum_vacuum_threshold=1000,
          autovacuum_analyze_scale_factor=0.01,autovacuum_analyze_threshold=1000)`);
        changed.push({ table, action: 'TABLE_AUTOVACUUM_OPTIONS' });
      }
      if (!recommendation) { changed.push({ table, action: 'NO_MAINTENANCE_NEEDED' }); continue; }
      // TRUNCATE FALSE avoids its optional exclusive lock; PARALLEL 0 keeps
      // manual work from borrowing more workers from the shared instance.
      await client.query(recommendation.action === 'VACUUM_ANALYZE'
        ? `VACUUM (ANALYZE, SKIP_LOCKED, TRUNCATE FALSE, PARALLEL 0) ${name}`
        : `ANALYZE (SKIP_LOCKED) ${name}`);
      changed.push(recommendation);
    }
    return changed;
  } finally {
    await client.query('RESET statement_timeout').catch(() => {});
    await client.query('RESET lock_timeout').catch(() => {});
    await client.query('RESET vacuum_cost_delay').catch(() => {});
    await client.query('SELECT pg_advisory_unlock(7311,111)').catch(() => {});
  }
}
