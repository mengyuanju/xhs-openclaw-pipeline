import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { QA_PENDING_SQL } from '../src/quality-review-statistics.mjs';

// Execute the production permission projection against fake assigned rows.
// SQLite accepts this SQL after removing PostgreSQL's type casts.
const pendingPermissionSql=QA_PENDING_SQL.slice(QA_PENDING_SQL.indexOf('\nSELECT a.*'))
  .replace(/::(?:bigint|text|uuid)/gu,'');

function pendingFixture({role='REVIEWER',status='ACTIVE',copyEnabled=1,imageEnabled=1}={}) {
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE app_users(id INTEGER,username TEXT,display_name TEXT,status TEXT,role TEXT,
    copy_qc_enabled INTEGER,image_qc_enabled INTEGER);
    CREATE TABLE assigned(id INTEGER,task_id INTEGER,stage TEXT,source TEXT,submitter_id INTEGER,
      priority_paused INTEGER,batch_id INTEGER);`);
  db.prepare('INSERT INTO app_users VALUES(11,?,?,?, ?,?,?)')
    .run('reviewer','质检员',status,role,copyEnabled,imageEnabled);
  const insert=db.prepare('INSERT INTO assigned VALUES(?,?,?,?,?,?,?)');
  for(const row of [
    [1,101,'COPY','v2',11,0,77],
    [2,102,'COPY','v2',11,1,77],
    [3,103,'COPY','legacy',11,0,77],
    [4,104,'IMAGE','legacy',11,0,77],
    [5,105,'IMAGE','v2',11,0,77],
    [6,106,'COPY','legacy',22,0,77],
    [7,107,'IMAGE','legacy',22,0,77],
    [8,108,'COPY','v2',22,0,88],
  ])insert.run(...row);
  const pending=db.prepare(pendingPermissionSql);
  return {db,read:(stage='',batchId=null,accountId=11)=>pending.all({$1:accountId,$2:stage,$3:batchId})};
}

test('pending QA includes own copy v2 items, keeps pause state, and excludes own legacy and image items',()=>{
  const fixture=pendingFixture();
  try {
    const rows=fixture.read();
    assert.deepEqual(rows.map(row=>row.id),[6,1,2,8,7]);
    assert.equal(rows.find(row=>row.id===1).blocked,0,'self-review is actionable in both SQL permission branches');
    assert.equal(rows.find(row=>row.id===2).blocked,1,'paused self-review remains blocked');
    assert.deepEqual(fixture.read('COPY',77).map(row=>row.id),[6,1,2]);
    assert.deepEqual(fixture.read('IMAGE').map(row=>row.id),[7]);
  } finally {fixture.db.close();}
});

test('copy self-review still requires an active account and copy QC permission',()=>{
  for(const [options,expected] of [
    [{role:'USER'},[6,1,2,8]],
    [{copyEnabled:0},[7]],
    [{status:'DISABLED'},[]],
  ]) {
    const fixture=pendingFixture(options);
    try {assert.deepEqual(fixture.read().map(row=>row.id),expected);}
    finally {fixture.db.close();}
  }
});

test('admin and global pending views retain their existing visibility',()=>{
  const admin=pendingFixture({role:'ADMIN',copyEnabled:0,imageEnabled:0});
  const disabled=pendingFixture({status:'DISABLED',copyEnabled:0,imageEnabled:0});
  try {
    assert.deepEqual(admin.read().map(row=>row.id),[3,6,1,2,8,4,7,5]);
    assert.equal(admin.read().find(row=>row.id===2).blocked,1);
    const global=disabled.read('',null,null);
    assert.deepEqual(global.map(row=>row.id),[3,6,1,2,8,4,7,5]);
    assert.deepEqual(global.filter(row=>row.blocked).map(row=>row.id),[2]);
  } finally {admin.db.close();disabled.db.close();}
});
