import assert from 'node:assert/strict';
import test from 'node:test';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createExecutionWorkNotifications } from '../src/execution-work-notifications.mjs';
import { taskListFactClient, taskListFactVersion } from '../src/task-list-facts.mjs';

test('PostgreSQL work notifications follow durable task and production setting commits only', {
  skip: process.env.RUN_OPERATOR_PERFORMANCE_POSTGRES !== '1', timeout:120_000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const repository = new PostgresControlPlaneRepository({connectionString:database.connectionString});
  let notifications, raw;
  try {
    await repository.initialize();
    await repository.pool.query("INSERT INTO executor_nodes(id,name) VALUES('notify-fixture','Notification fixture')");
    const task = (await repository.pool.query("INSERT INTO tasks(query,state,created_by_node_id) VALUES('Notification fixture','COPY_QUEUED','notify-fixture') RETURNING id")).rows[0].id;
    notifications = createExecutionWorkNotifications({pool:repository.pool});
    let cursor = await notifications.wait({nodeId:'subscriber-without-registration'});
    const pending = notifications.wait({...cursor,nodeId:'subscriber-without-registration'});
    raw = await repository.pool.connect();
    const writer = taskListFactClient(raw,repository.pool);
    await writer.query('BEGIN');
    await writer.query('UPDATE tasks SET state=$2 WHERE id=$1',[task,'CANCELLED']);
    await writer.query("INSERT INTO global_settings(key,value) VALUES('production','{}') ON CONFLICT(key) DO UPDATE SET value='{}'");
    await writer.query('ROLLBACK');assert.equal(notifications.pendingCount,1);
    await writer.query('BEGIN');await writer.query('SAVEPOINT ignored');
    await writer.query('UPDATE tasks SET state=$2 WHERE id=$1',[task,'CANCELLED']);
    await writer.query("UPDATE global_settings SET value='{}' WHERE key='production'");
    await writer.query('ROLLBACK TO SAVEPOINT ignored');await writer.query('COMMIT');
    assert.equal(notifications.pendingCount,1);assert.equal(taskListFactVersion(repository.pool),0);
    await writer.query('BEGIN');
    await writer.query('UPDATE tasks SET progress_percent=10,progress_message=$2,current_stage=$3,last_activity_at=now(),updated_at=now() WHERE id=$1',[task,'Working','COPY_QUERY']);
    await writer.query('UPDATE tasks SET state=$2 WHERE id=$1',[task+99999,'CANCELLED']);
    await writer.query('UPDATE executor_nodes SET last_seen_at=now() WHERE id=$1',['notify-fixture']);
    await writer.query('COMMIT');assert.equal(notifications.pendingCount,1);
    await writer.query('BEGIN');await writer.query('UPDATE tasks SET priority_paused=true WHERE id=$1',[task]);
    assert.equal(notifications.pendingCount,1);await writer.query('COMMIT');
    cursor = await pending;
    assert.equal(cursor.changed,true);assert.equal(cursor.revision,1);assert.equal(cursor.settingsRevision,0);
    const settingWait = notifications.wait({...cursor,nodeId:'subscriber-without-registration'});
    await repository.upsertSetting('production',{paused:true});
    const setting = await settingWait;
    assert.equal(setting.revision,2);assert.equal(setting.settingsRevision,1);assert.equal(setting.changed,true);
    assert.equal(taskListFactVersion(repository.pool),2,'settings do not advance counts');
    const finalWait = notifications.wait({...setting,nodeId:'subscriber-without-registration'});
    await writer.query('BEGIN');await writer.query('UPDATE tasks SET priority_paused=false WHERE id=$1',[task]);
    await writer.query("UPDATE global_settings SET value='{\"paused\":false}',version=version+1 WHERE key='production'");
    await writer.query('COMMIT');
    const combined = await finalWait;
    assert.equal(combined.revision,3,'one transaction emits one wake');assert.equal(combined.settingsRevision,2);
    assert.equal(Number((await repository.pool.query('SELECT count(*) AS n FROM execution_claim_requests')).rows[0].n),0);
    assert.equal(Number((await repository.pool.query('SELECT count(*) AS n FROM task_executions')).rows[0].n),0);
    assert.equal(Number((await repository.pool.query('SELECT count(*) AS n FROM executor_nodes')).rows[0].n),1,'the subscriber never registers a node');
  } finally {
    notifications?.dispose();raw?.release();await repository.close();await database.stop();
  }
});
