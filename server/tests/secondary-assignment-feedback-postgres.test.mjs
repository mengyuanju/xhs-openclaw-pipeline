import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { readSecondaryAssignmentFeedback } from '../src/secondary-assignment-feedback.mjs';

test('feedback SQL binds the active reset cycle, retaining v2 and legacy verdicts without future or stale cases', {
  skip: process.env.RUN_SECONDARY_ASSIGNMENT_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const database = await startTemporaryPostgres18();
  const pool = new pg.Pool({ connectionString: database.connectionString });
  try {
    // Isolated read fixtures use the production table/column names and types;
    // workflow mutations are covered separately by secondary-assignment-postgres.
    await pool.query(`
      CREATE TABLE tasks(id bigint PRIMARY KEY,assigned_to_user_id text,assigned_at timestamptz);
      CREATE TABLE task_assignment_records(id bigint PRIMARY KEY,task_id bigint,
        assignee_account_id bigint,assignee_username_snapshot text,previous_record_id bigint,
        source text,assigned_at timestamptz,ended_at timestamptz);
      CREATE TABLE task_reassignment_cases(id bigint PRIMARY KEY,task_id bigint,stage text,
        assignment_record_id bigint,target_account_id bigint,status text,reset_status text,
        created_at timestamptz,disposed_at timestamptz,source_copy_qa_member_v2_id bigint,
        source_item_id bigint,reason_codes text[],note text);
      CREATE TABLE copy_qa_batch_members_v2(id bigint PRIMARY KEY,task_id bigint,
        quality_cycle integer,reason_codes text[],reason_snapshots jsonb,note text,decided_at timestamptz);
      CREATE TABLE copy_qa_return_events_v2(id bigint PRIMARY KEY,task_id bigint,
        quality_cycle integer,member_id bigint,legacy_item_id bigint,created_at timestamptz);
      CREATE TABLE copy_sampling_items(id bigint PRIMARY KEY,task_id bigint,freeze_id bigint,
        public_id uuid,reason_codes text[],note text,reviewed_at timestamptz);
      CREATE TABLE copy_sampling_events(id bigint PRIMARY KEY,freeze_id bigint,sampling_item_id bigint,
        action text,reason_codes text[],note text,details jsonb,created_at timestamptz);
      CREATE TABLE image_sampling_items(id bigint PRIMARY KEY,task_id bigint,reviewed_at timestamptz);
      CREATE TABLE image_sampling_events(id bigint PRIMARY KEY,sampling_item_id bigint,
        action text,details jsonb,created_at timestamptz);
      INSERT INTO tasks VALUES(108,'current-operator','2026-09-30T01:00:00Z');
      INSERT INTO task_assignment_records VALUES
        (11,108,1,'SECRET-OPERATOR',NULL,'MANUAL','2026-09-28T01:00:00Z','2026-09-29T01:00:00Z'),
        (12,108,2,'current-operator',11,'SECOND_ASSIGNMENT','2026-09-30T01:00:00Z',NULL);
      INSERT INTO copy_qa_batch_members_v2 VALUES
        (132,108,0,ARRAY['CUSTOM:SOURCE'],
          '[{"code":"CUSTOM:SOURCE","group":"PLAN","label":"小程序截图说明有误"}]','最新移交反馈：修改第 4 页','2026-09-29T01:00:00Z'),
        (130,108,0,ARRAY['FACT_ERROR'],'[]','此前正文问题','2026-09-28T03:00:00Z'),
        (200,108,1,ARRAY['FACT_ERROR'],'[]','SECRET-WRONG-CYCLE','2026-09-28T03:00:00Z'),
        (201,108,0,ARRAY['FACT_ERROR'],'[]','SECRET-FUTURE-RETURN','2026-10-01T03:00:00Z');
      INSERT INTO task_reassignment_cases VALUES
        (101,108,'COPY',11,2,'REASSIGNED','READY','2026-09-29T01:00:00Z',
          '2026-09-30T01:00:00.002Z',132,NULL,ARRAY['CUSTOM:SOURCE'],'最新移交反馈：修改第 4 页'),
        (998,108,'COPY',11,3,'REASSIGNED','READY','2026-09-29T01:00:00Z',
          '2026-09-30T01:00:00Z',200,NULL,ARRAY['FACT_ERROR'],'SECRET-WRONG-TARGET'),
        (999,108,'COPY',11,2,'REASSIGNED','READY','2026-10-01T01:00:00Z',
          '2026-10-02T01:00:00Z',200,NULL,ARRAY['FACT_ERROR'],'SECRET-FUTURE-CASE');
      INSERT INTO copy_sampling_items VALUES
        (501,108,61,'51515151-5151-4151-8151-515151515151',ARRAY['CUSTOM:LEGACY'],
          '此前批次反馈','2026-09-28T02:00:00Z');
      INSERT INTO copy_sampling_events VALUES
        (601,61,502,'RETURN_BATCH',ARRAY['CUSTOM:LEGACY'],'见此前截图',
          '{"reasonSnapshots":[{"code":"CUSTOM:LEGACY","group":"BODY","label":"使用方法不符"}],"affectedItemIds":["51515151-5151-4151-8151-515151515151"]}',
          '2026-09-28T02:00:00Z'),
        (602,61,501,'RETURN_SINGLE',ARRAY['FACT_ERROR'],'SECRET-FUTURE-VERDICT','{}','2026-10-01T02:00:00Z');
      INSERT INTO copy_qa_return_events_v2 VALUES
        (701,108,0,132,NULL,'2026-09-29T01:00:00Z'),
        (702,108,0,130,NULL,'2026-09-28T03:00:00Z'),
        (703,108,0,NULL,501,'2026-09-28T02:00:00Z'),
        (704,108,1,200,NULL,'2026-09-28T03:00:00Z'),
        (705,108,0,201,NULL,'2026-10-01T03:00:00Z');
    `);
    const result = await readSecondaryAssignmentFeedback(pool, 108);
    assert.deepEqual(result, { assignedAt: '2026-09-30T01:00:00.000Z', entries: [
      { stage: 'COPY', reasonLabels: ['图文规划 · 小程序截图说明有误'], note: '最新移交反馈：修改第 4 页', reviewedAt: '2026-09-29T01:00:00.000Z' },
      { stage: 'COPY', reasonLabels: ['正文 · 事实或数据错误'], note: '此前正文问题', reviewedAt: '2026-09-28T03:00:00.000Z' },
      { stage: 'COPY', reasonLabels: ['正文 · 使用方法不符'], note: '见此前截图', reviewedAt: '2026-09-28T02:00:00.000Z' },
    ] });
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
    await pool.query("UPDATE task_assignment_records SET source='MANUAL' WHERE id=12");
    assert.equal(await readSecondaryAssignmentFeedback(pool, 108), null, 'a later ordinary assignment is not a secondary reset');
    await pool.query("UPDATE task_assignment_records SET source='SECOND_ASSIGNMENT',previous_record_id=10 WHERE id=12");
    assert.equal(await readSecondaryAssignmentFeedback(pool, 108), null, 'no fallback to an unrelated prior assignment');
    await pool.query("UPDATE task_assignment_records SET previous_record_id=11,assignee_account_id=4 WHERE id=12");
    assert.equal(await readSecondaryAssignmentFeedback(pool, 108), null, 'no fallback to a different case target');

    // Legacy escalation has no v2 source member. The migrated ledger's cycle is
    // the count of completed second assignments at the time this case opened.
    await pool.query(`
      INSERT INTO tasks VALUES(236,'legacy-current','2026-09-30T02:00:00Z');
      INSERT INTO task_assignment_records VALUES
        (22,236,4,'legacy-current',21,'SECOND_ASSIGNMENT','2026-09-30T02:00:00Z',NULL);
      INSERT INTO copy_sampling_items VALUES
        (580,236,81,'58585858-5858-4858-8858-585858585858',ARRAY['TITLE_AI_TONE'],'再次复检仍有错误','2026-09-29T04:00:00Z');
      INSERT INTO task_reassignment_cases VALUES
        (80,236,'COPY',19,3,'REASSIGNED','READY','2026-09-20T01:00:00Z',
          '2026-09-21T01:00:00Z',NULL,570,ARRAY['FACT_ERROR'],'SECRET-OLDER-CYCLE'),
        (102,236,'COPY',21,4,'REASSIGNED','READY','2026-09-29T04:00:00Z',
          '2026-09-30T02:00:00.002Z',NULL,580,ARRAY['TITLE_AI_TONE'],'再次复检仍有错误');
      INSERT INTO copy_qa_batch_members_v2 VALUES
        (270,236,1,ARRAY['FACT_ERROR'],'[]','本轮此前的返工问题','2026-09-28T04:00:00Z'),
        (271,236,0,ARRAY['FACT_ERROR'],'[]','SECRET-OLDER-VERDICT','2026-09-20T04:00:00Z');
      INSERT INTO copy_qa_return_events_v2 VALUES
        (710,236,1,270,NULL,'2026-09-28T04:00:00Z'),
        (711,236,0,271,NULL,'2026-09-20T04:00:00Z');
    `);
    const legacy = await readSecondaryAssignmentFeedback(pool, 236);
    assert.deepEqual(legacy.entries.map(entry => entry.note), ['再次复检仍有错误', '本轮此前的返工问题']);
    assert.equal(legacy.entries[0].reasonLabels[0], '标题 · AI感严重');
    assert.equal(await readSecondaryAssignmentFeedback(pool, 950), null);

    await pool.query(`
      INSERT INTO tasks VALUES(301,'image-current','2026-09-30T03:00:00Z');
      INSERT INTO task_assignment_records VALUES
        (32,301,5,'image-current',31,'SECOND_ASSIGNMENT','2026-09-30T03:00:00Z',NULL);
      INSERT INTO image_sampling_items VALUES(880,301,'2026-09-29T05:00:00Z');
      INSERT INTO task_reassignment_cases VALUES
        (103,301,'IMAGE',31,5,'REASSIGNED','READY','2026-09-29T05:00:00Z',
          '2026-09-30T03:00:00.002Z',NULL,880,ARRAY['CUSTOM:IMAGE'],'图片此前质检的具体反馈');
      INSERT INTO image_sampling_events VALUES
        (901,880,'ESCALATE_ADMIN',
          '{"caseId":103,"reasonSnapshots":[{"code":"CUSTOM:IMAGE","label":"页面元素位置错误"}]}','2026-09-29T05:00:00.001Z'),
        (902,880,'ESCALATE_ADMIN',
          '{"caseId":104,"reasonSnapshots":[{"code":"CUSTOM:IMAGE","label":"SECRET-WRONG-IMAGE-CASE"}]}','2026-09-29T05:00:00.002Z');
    `);
    assert.deepEqual((await readSecondaryAssignmentFeedback(pool, 301)).entries, [
      { stage: 'IMAGE', reasonLabels: ['页面元素位置错误'], note: '图片此前质检的具体反馈', reviewedAt: '2026-09-29T05:00:00.000Z' },
    ]);

    await pool.query(`
      UPDATE task_assignment_records SET assignee_account_id=2 WHERE id=12;
      INSERT INTO copy_qa_batch_members_v2(id,task_id,quality_cycle,reason_codes,reason_snapshots,note,decided_at)
      SELECT 1000+counter,108,0,ARRAY['FACT_ERROR'],'[]'::jsonb,'历史反馈 '||counter,
        '2026-09-28T04:00:00Z'::timestamptz+counter*interval '1 minute'
      FROM generate_series(1,60) AS counter;
      INSERT INTO copy_qa_return_events_v2(id,task_id,quality_cycle,member_id,created_at)
      SELECT 1000+counter,108,0,1000+counter,
        '2026-09-28T04:00:00Z'::timestamptz+counter*interval '1 minute'
      FROM generate_series(1,60) AS counter;
    `);
    const bounded = await readSecondaryAssignmentFeedback(pool, 108);
    assert.equal(bounded.entries.length, 50);
    assert.equal(bounded.entries[0].note, '最新移交反馈：修改第 4 页');
    assert.equal(bounded.entries[1].note, '历史反馈 60');
    assert.equal(bounded.entries.at(-1).note, '历史反馈 12');
  } finally {
    await pool.end();
    await database.stop();
  }
});
