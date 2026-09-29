import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { readAnnotationDiscardFacts } from '../src/annotation-discard-facts.mjs';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';

test('annotation discards retain historical account attribution and Shanghai date boundaries',{
  skip:process.env.RUN_PERSONAL_WORKSPACE_POSTGRES!=='1',timeout:120_000,
},async t=>{
  const database=await startTemporaryPostgres18();
  const pool=new pg.Pool({connectionString:database.connectionString});
  try {
    // The fact reader needs only the durable audit columns. These small tables
    // exercise its real SQL without unrelated workflow mutations or model calls.
    await pool.query(`CREATE TABLE app_users(id bigint PRIMARY KEY,username text,display_name text,created_at timestamptz);
      CREATE TABLE tasks(id bigint PRIMARY KEY,query text,production_batch_id bigint,assigned_to_account_id bigint);
      CREATE TABLE copy_revisions(id bigint PRIMARY KEY,revision_origin text,copy_rework_satisfied boolean);
      CREATE TABLE human_quality_assessments(id bigint PRIMARY KEY,task_id bigint,stage text,
        action text,reviewer_username text,copy_revision_id bigint,created_at timestamptz);
      CREATE TABLE task_reassignment_assessment_records(task_id bigint,assessment_id bigint,
        stage text,action text,created_at timestamptz,reviewer_username text,case_id bigint);
      CREATE TABLE image_approval_events(task_id bigint,submitted_at timestamptz);
      CREATE TABLE copy_return_dispositions(id bigint PRIMARY KEY,task_id bigint,
        actor_account_id bigint,actor_username text,created_at timestamptz);
      CREATE TABLE image_task_dispositions(id bigint PRIMARY KEY,task_id bigint,
        actor_account_id bigint,actor_username text,from_state text,created_at timestamptz)`);
    await pool.query(`INSERT INTO app_users VALUES
        (22,'recycled','新账户','2026-09-20T00:00:00+08:00'),
        (33,'original','原审核人','2026-09-01T00:00:00+08:00');
      INSERT INTO tasks VALUES(1,'private discard query',7,22);
      INSERT INTO copy_revisions VALUES(1,'GENERATION',false),(2,'QA_RETURN',false);
      INSERT INTO human_quality_assessments VALUES
        (1,1,'COPY','DISCARD','recycled',1,'2026-09-15T09:00:00+08:00'),
        (2,1,'COPY','DISCARD','recycled',1,'2026-09-21T09:00:00+08:00'),
        (3,1,'COPY','DISCARD','original',1,'2026-09-14T16:00:00Z'),
        (4,1,'COPY','DISCARD','original',2,'2026-09-16T16:00:00Z');
      INSERT INTO task_reassignment_assessment_records VALUES
        (1,3,'COPY','DISCARD','2026-09-14T16:00:00Z','original',1),
        (1,5,'COPY','DISCARD','2026-09-18T09:00:00+08:00','original',1),
        (1,5,'COPY','DISCARD','2026-09-18T09:00:00+08:00','original',2);
      INSERT INTO copy_return_dispositions VALUES
        (1,1,11,'recycled','2026-09-15T12:00:00+08:00'),
        (2,1,33,'original','2026-09-16T15:59:59.999Z'),
        (3,1,33,'original','2026-09-16T16:00:00Z')`);
    const options={start:'2026-09-14T16:00:00Z',end:'2026-09-29T16:00:00Z',
      asOf:'2026-09-29T10:00:00Z',stage:'COPY'};
    await t.test('a recreated username receives only discards after its account was created',async()=>{
      const facts=await readAnnotationDiscardFacts(pool,{...options,accountId:22});
      assert.deepEqual(facts.map(row=>row.id),['annotation-discard:copy-review:2']);
      assert.ok(facts.every(row=>row.accountId===22));
    });
    await t.test('a deleted actor retains dispositions under the immutable account id',async()=>{
      const facts=await readAnnotationDiscardFacts(pool,{...options,accountId:11});
      assert.equal(facts.length,1);assert.equal(facts[0].id,'annotation-discard:copy-return:1');
      assert.equal(facts[0].accountId,11);assert.equal(facts[0].rework,true);
    });
    await t.test('both initial and returned copy discards count for their operator after task reassignment',async()=>{
      const facts=await readAnnotationDiscardFacts(pool,{...options,accountId:33,end:'2026-09-16T16:00:00Z'});
      assert.deepEqual(facts.map(row=>row.id),[
        'annotation-discard:copy-review:3','annotation-discard:copy-return:2']);
      assert.deepEqual(facts.map(row=>row.rework),[false,true]);
      assert.ok(facts.every(row=>row.accountId===33 && row.kind==='ANNOTATION_DISCARD'));
    });
    await t.test('the unfiltered report preserves known historical disposition actors',async()=>{
      const facts=await readAnnotationDiscardFacts(pool,options);
      assert.ok(facts.some(row=>row.accountId===11));
      assert.ok(!facts.some(row=>row.id==='annotation-discard:copy-review:1'));
    });
    await t.test('archived assessments survive reassignment without duplicating a live or repeated archive record',async()=>{
      const facts=await readAnnotationDiscardFacts(pool,{...options,accountId:33});
      assert.equal(facts.filter(row=>row.id==='annotation-discard:copy-review:3').length,1);
      const archived=facts.filter(row=>row.id==='annotation-discard:copy-review:5');
      assert.equal(archived.length,1);
      assert.equal(archived[0].accountId,33);
      assert.equal(archived[0].at,'2026-09-18T01:00:00.000Z');
    });
  } finally {await pool.end();await database.stop();}
});
