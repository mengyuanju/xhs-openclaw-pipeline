import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startTemporaryPostgres18 } from './helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';
import { createCopyQaBatchV2, decideCopyQaItemV2 } from '../src/copy-qa-v2.mjs';

test('today receipts count every valid submission and classify copy QA v2 repeat decisions',{
  skip:process.env.RUN_PERSONAL_WORKSPACE_POSTGRES!=='1',timeout:120_000,
},async()=>{
  const database=await startTemporaryPostgres18();
  const repository=new PostgresControlPlaneRepository({connectionString:database.connectionString});
  try {
    await repository.initialize();
    const db=repository.pool;
    const users=(await db.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,created_at)
      VALUES ('today-maker','标注','USER','test','ACTIVE',now()-interval '1 day'),
        ('today-reviewer','质检','REVIEWER','test','ACTIVE',now()-interval '1 day')
      RETURNING id,username,role`)).rows;
    const [maker,reviewer]=users.map(row=>({userId:Number(row.id),username:row.username,role:row.role}));
    await db.query("INSERT INTO executor_nodes(id,name) VALUES ('today-test','Test')");
    const taskId=Number((await db.query(`INSERT INTO tasks(query,input,state,created_by_node_id,
        created_by_user_id,assigned_to_user_id,assigned_at,assignment_source)
      VALUES ('private work','{}','COPY_QC_PENDING','today-test','today-maker',
        'today-maker',now(),'MANUAL') RETURNING id`)).rows[0].id);
    const dayStart="date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'";
    await db.query(`INSERT INTO operator_performance_events(event_key,task_id,account_id,stage,kind,occurred_at,data)
      VALUES ('today-excluded',$1,$2,'COPY','SUBMIT',${dayStart}+interval '1 hour',
          '{"firstSubmission":true,"rework":false,"exclusion":"SIMULATED"}'),
        ('today-valid',$1,$2,'COPY','SUBMIT',${dayStart}+interval '2 hours',
          '{"firstSubmission":false,"rework":false}'),
        ('today-repeat',$1,$2,'COPY','SUBMIT',${dayStart}+interval '2 hours 10 minutes',
          '{"firstSubmission":false,"rework":false}'),
        ('today-rework',$1,$2,'COPY','SUBMIT',${dayStart}+interval '2 hours 20 minutes',
          '{"firstSubmission":false,"rework":true}'),
        ('today-image-first',$1,$2,'IMAGE','SUBMIT',${dayStart}+interval '2 hours',
          '{"firstSubmission":true,"rework":false}'),
        ('today-image-repeat',$1,$2,'IMAGE','SUBMIT',${dayStart}+interval '2 hours 10 minutes',
          '{"firstSubmission":false,"rework":false}'),
        ('today-other-account',$1,$3,'COPY','SUBMIT',${dayStart}+interval '5 hours',
          '{"firstSubmission":false,"rework":false}')`,[taskId,maker.userId,reviewer.userId]);
    await db.query(`INSERT INTO account_quality_events(event_key,task_id,stage,account_id,
        action,establishes_sample,occurred_at,data)
      VALUES ('copy-v2:today-1',$1,'COPY',$2,'RETURN',true,${dayStart}+interval '3 hours',
          '{"qaBatchId":1,"samplingItemId":1001}'),
        ('copy-v2:today-2',$1,'COPY',$2,'PASS',true,${dayStart}+interval '4 hours',
          '{"qaBatchId":2,"samplingItemId":1002}')`,[taskId,maker.userId]);
    await db.query(`INSERT INTO quality_review_activity_events(event_key,account_id,task_id,
        stage,kind,occurred_at,data)
      VALUES ('copy-v2:today-1',$1,$2,'COPY','QA_REVIEW',${dayStart}+interval '3 hours 1 second',
          '{"qaBatchId":1,"samplingItemId":1001,"outcome":"RETURN"}'),
        ('copy-v2:today-2',$1,$2,'COPY','QA_REVIEW',${dayStart}+interval '4 hours 1 second',
          '{"qaBatchId":2,"samplingItemId":1002,"outcome":"PASS"}')`,[reviewer.userId,taskId]);
    const personal=await repository.personalWorkspace(maker,{section:'personal'},true);
    assert.equal(personal.annotation.COPY.firstSubmissions,1);
    assert.equal(personal.annotation.COPY.reworkSubmissions,1);
    assert.equal(personal.annotation.COPY.submissions,3);
    assert.equal(personal.annotation.IMAGE.submissions,2);
    assert.deepEqual(personal.annotation.COPY.quality,
      {firstPassed:0,passed:1,decided:2,firstPassRate:0,rate:0.5});
    assert.equal((await repository.personalQualityActivity(maker,
      {metric:'submitFirst',stage:'COPY'})).total,1);
    for(const stage of ['COPY','IMAGE']) {
      const receipts=await repository.personalQualityActivity(maker,{metric:'submitAll',stage});
      assert.equal(receipts.total,personal.annotation[stage].submissions);
      assert.equal(receipts.items.filter(item=>item.submissionType==='REPEAT').length,1);
      assert.ok(receipts.items.every(item=>item.stage===stage && item.taskId===undefined));
    }
    const paginated=await repository.personalQualityActivity(maker,{metric:'submitAll',page:2,pageSize:2});
    assert.equal(paginated.total,5);assert.equal(paginated.page,2);assert.equal(paginated.items.length,2);
    const qa=await repository.personalWorkspace(reviewer,{section:'personal'},true);
    assert.deepEqual(Object.fromEntries(['firstReviews','rechecks','passed','returned','reviews']
      .map(key=>[key,qa.qa.COPY[key]])),{firstReviews:1,rechecks:1,passed:1,returned:1,reviews:2});
    const first=await repository.personalQualityActivity(reviewer,{metric:'qaFirst',stage:'COPY'});
    const recheck=await repository.personalQualityActivity(reviewer,{metric:'qaRecheck',stage:'COPY'});
    assert.equal(first.total,1);assert.equal(first.items[0].sampleKind,'RANDOM');
    assert.equal(recheck.total,1);assert.equal(recheck.items[0].sampleKind,'MANDATORY_RECHECK');
  } finally {await repository.pool.end();await database.stop();}
});

test('today personal QA separates inspected items from attributed batch coverage and retains anonymous receipts',{
  skip:process.env.RUN_PERSONAL_WORKSPACE_POSTGRES!=='1',timeout:180_000,
},async t=>{
  const database=await startTemporaryPostgres18();
  const repository=new PostgresControlPlaneRepository({connectionString:database.connectionString});
  const db=repository.pool;
  try {
    await repository.initialize();
    await db.query("INSERT INTO executor_nodes(id,name) VALUES('today-coverage-node','Test Node')");
    const labels=['admin','maker','pass','return','zero-impact','first-reviewer','last-reviewer','image','special','legacy'];
    const actors={};
    for(const label of labels) {
      const row=(await db.query(`INSERT INTO app_users(username,display_name,role,password_hash,status,
          copy_review_enabled,copy_qc_enabled,image_qc_enabled,created_at)
        VALUES($1,$1,$2,'test-only','ACTIVE',true,true,true,now()-interval '1 day')
        RETURNING id,username,role,credential_version`,
      [`coverage-${label}`,label==='admin'?'ADMIN':label==='maker'?'USER':'REVIEWER'])).rows[0];
      actors[label]={userId:Number(row.id),username:row.username,role:row.role,
        credentialVersion:Number(row.credential_version)};
    }
    await db.query(`UPDATE workflow_quality_settings SET copy_sampling_enabled=true,
      copy_sampling_rate_bps=1000,copy_batch_return_threshold_bps=5000`);

    async function candidate(existingTaskId=null,{mandatory=false}={}) {
      const taskId=existingTaskId??Number((await db.query(`INSERT INTO tasks(query,input,state,
          created_by_node_id,created_by_user_id,assigned_to_user_id,assigned_at,assignment_source)
        VALUES('private coverage query','{}','COPY_QC_PENDING','today-coverage-node',$1,$1,now(),'MANUAL')
        RETURNING id`,[actors.maker.username])).rows[0].id);
      const revisionId=Number((await db.query(`INSERT INTO copy_revisions(task_id,revision,content,
          revision_origin,approved_at)
        SELECT $1,COALESCE(max(revision),0)+1,$2,'GENERATION',now()
        FROM copy_revisions WHERE task_id=$1 RETURNING id`,[taskId,
        {copy:{title:'private coverage title',body:'private coverage content',tags:[]},imagePlan:[]}])).rows[0].id);
      await db.query(`UPDATE tasks SET state='COPY_QC_PENDING',current_stage='COPY_QC_PENDING',
        current_copy_revision_id=$2,mandatory_copy_qc=$3,mandatory_copy_qc_origin=$4 WHERE id=$1`,
      [taskId,revisionId,mandatory,mandatory?'SECOND_ASSIGNMENT':null]);
      await db.query(`INSERT INTO copy_approval_events(task_id,copy_revision_id,approval_mode,
          approved_by_account_id,approved_by_username,content_sha256)
        VALUES($1,$2,'MANUAL',$3,$4,$5)`,
      [taskId,revisionId,actors.maker.userId,actors.maker.username,'a'.repeat(64)]);
      return taskId;
    }
    async function batch(count,sampleCount) {
      const taskIds=[];
      for(let index=0;index<count;index++)taskIds.push(await candidate());
      await createCopyQaBatchV2(db,{mode:'PERSONAL_MANUAL',accountId:actors.maker.userId,
        taskIds,sampleTaskIds:taskIds.slice(0,sampleCount),requestId:randomUUID()},actors.admin);
      return {taskIds,members:(await db.query(`SELECT * FROM copy_qa_batch_members_v2
        WHERE task_id=ANY($1::bigint[]) ORDER BY id`,[taskIds])).rows};
    }
    async function decide(member,actor,decision='PASS') {
      return decideCopyQaItemV2(db,member.public_id,{requestId:randomUUID(),
        revisionToken:member.content_sha256,decision,
        ...(decision==='RETURN'?{reasonCodes:['TITLE_AI_TONE'],note:'test-only return'}:{})},actor);
    }
    const dayStart="date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'";
    async function activity({key,actor,taskId,stage='COPY',kind='QA_REVIEW',outcome='PASS',data={},offset='5 hours'}) {
      await db.query(`INSERT INTO quality_review_activity_events(event_key,account_id,task_id,
          stage,kind,occurred_at,data) VALUES($1,$2,$3,$4,$5,(${dayStart})+$6::interval,$7)`,
      [key,actor.userId,taskId,stage,kind,offset,{outcome,sampleKind:'RANDOM',
        query:'private receipt query',content:'private receipt content',...data}]);
    }
    async function coverage({key,actor,taskId,stage='IMAGE',kind='BATCH_RETURN',operationKey,data={},offset='5 hours'}) {
      await db.query(`INSERT INTO quality_review_coverage_events(event_key,account_id,task_id,
          stage,review_item_key,kind,occurred_at,operation_key,data)
        VALUES($1,$2,$3,$4,$5,$6,(${dayStart})+$7::interval,$8,$9)`,
      [`coverage:${operationKey}:${key}`,actor?.userId??null,taskId,stage,key,kind,offset,
        operationKey,{...data,query:'private batch query',content:'private batch content'}]);
    }
    const metricFields={qaActual:'actualOperations',qaCoverage:'processingCoverage',
      qaBatchReturned:'batchReturned',qaBatchReleased:'batchReleased',qaDiscarded:'discarded',qaEscalated:'escalated'};
    async function verifyReceipts(actor,stage,expected) {
      const report=await repository.personalWorkspace(actor,{section:'personal'},true);
      const qa=report.qa[stage];
      for(const [field,value] of Object.entries(expected))assert.equal(qa[field],value,`${actor.username}.${stage}.${field}`);
      for(const [metric,field] of Object.entries(metricFields)) {
        const detail=await repository.personalQualityActivity(actor,{stage,metric,pageSize:100});
        assert.equal(detail.total,qa[field],`${metric} total matches its card`);
        const needsCoverage=['qaCoverage','qaBatchReturned','qaBatchReleased'].includes(metric);
        assert.equal(detail.coverageIncomplete,needsCoverage && qa.coverageIncomplete,
          `${metric} only marks missing historical coverage for coverage metrics`);
        assert.ok(detail.items.every(row=>row.stage===stage&&row.taskId===undefined&&row.query===undefined
          &&row.content===undefined&&row.accountId===undefined&&row.reviewItemKey===undefined),
        `${metric} is an anonymous receipt`);
        assert.doesNotMatch(JSON.stringify(detail),/private (?:coverage|receipt|batch) (?:query|title|content)/u);
        if(metric==='qaCoverage')assert.ok(detail.items.every(row=>Array.isArray(row.coverageSources)
          &&row.coverageSources.every(source=>['DIRECT','BATCH_RETURN','BATCH_RELEASE'].includes(source))));
      }
      return qa;
    }

    const allPass=await batch(100,10);
    await t.test('100 members with 10 PASS decisions preserve 10 actual items and 100 processed items',async()=>{
      for(const member of allPass.members.filter(row=>row.selected))await decide(member,actors.pass);
      await verifyReceipts(actors.pass,'COPY',{actualOperations:10,processingCoverage:100,
        batchReturned:0,batchReleased:90,batchActions:1,discarded:0,escalated:0,coverageIncomplete:false});
      assert.equal(Number((await db.query(`SELECT count(*) FROM quality_review_coverage_events
        WHERE account_id=$1 AND kind='BATCH_RELEASE'`,[actors.pass.userId])).rows[0].count),90,
      'the production closure writes all uninspected release objects');
      const receipts=await repository.personalQualityActivity(actors.pass,{metric:'qaCoverage',stage:'COPY',pageSize:100});
      assert.equal(receipts.items.filter(row=>row.coverageSources.includes('DIRECT')).length,10);
      assert.equal(receipts.items.filter(row=>row.coverageSources.includes('BATCH_RELEASE')).length,90);
    });

    await t.test('5 direct returns trigger 95 automatic returns without inventing 100 inspected items',async()=>{
      const rejected=await batch(100,10);
      for(const member of rejected.members.filter(row=>row.selected).slice(0,5))await decide(member,actors.return,'RETURN');
      await verifyReceipts(actors.return,'COPY',{actualOperations:5,processingCoverage:100,
        batchReturned:95,batchReleased:0,batchActions:1,discarded:0,escalated:0,coverageIncomplete:false});
      assert.equal(Number((await db.query(`SELECT count(*) FROM quality_review_coverage_events
        WHERE account_id=$1 AND kind='BATCH_RETURN'`,[actors.return.userId])).rows[0].count),95,
      'the production threshold writes only its batch affected objects');
    });

    await t.test('a threshold reached on the last item still retains one zero-impact batch action',async()=>{
      const rejected=await batch(1,1);
      await decide(rejected.members[0],actors['zero-impact'],'RETURN');
      await verifyReceipts(actors['zero-impact'],'COPY',{actualOperations:1,processingCoverage:1,
        batchReturned:0,batchReleased:0,batchActions:1,coverageIncomplete:false});
    });

    await t.test('two reviewers retain their own inspected items and only the trigger owns batch release',async()=>{
      const mixed=await batch(10,2),selected=mixed.members.filter(row=>row.selected);
      await decide(selected[0],actors['first-reviewer']);
      await decide(selected[1],actors['last-reviewer']);
      await verifyReceipts(actors['first-reviewer'],'COPY',{actualOperations:1,processingCoverage:1,
        batchReleased:0,batchActions:0,coverageIncomplete:false});
      await verifyReceipts(actors['last-reviewer'],'COPY',{actualOperations:1,processingCoverage:9,
        batchReleased:8,batchActions:1,coverageIncomplete:false});
    });

    await t.test('a new recheck member counts again while prior receipts survive the task version change',async()=>{
      const taskId=await candidate(allPass.taskIds[0],{mandatory:true});
      await createCopyQaBatchV2(db,{mode:'PERSONAL_MANUAL',accountId:actors.maker.userId,
        taskIds:[taskId],sampleTaskIds:[],requestId:randomUUID()},actors.admin);
      const member=(await db.query(`SELECT * FROM copy_qa_batch_members_v2 WHERE task_id=$1
        ORDER BY id DESC LIMIT 1`,[taskId])).rows[0];
      await decide(member,actors.pass);
      await verifyReceipts(actors.pass,'COPY',{actualOperations:11,processingCoverage:101,
        batchReleased:90,rechecks:1,coverageIncomplete:false});
    });

    await t.test('an image individually checked before its ten-item batch return contributes one covered item',async()=>{
      const operationKey=`IMAGE:legacy:77:BATCH_RETURN:${randomUUID()}`;
      await activity({key:'image-review:9001',actor:actors.image,stage:'IMAGE',taskId:9001,
        data:{freezeId:77,samplingItemId:9001,reviewItemKey:'IMAGE:legacy:77:9001'}});
      for(let taskId=9001;taskId<=9010;taskId++)await coverage({key:`IMAGE:legacy:77:${taskId}`,
        actor:actors.image,taskId,operationKey,data:{freezeId:77,samplingItemId:taskId,source:'BATCH_RETURN'}});
      await verifyReceipts(actors.image,'IMAGE',{actualOperations:1,processingCoverage:10,
        batchReturned:10,batchReleased:0,batchActions:1,coverageIncomplete:false});
      const receipts=await repository.personalQualityActivity(actors.image,{metric:'qaCoverage',stage:'IMAGE',pageSize:100});
      assert.equal(receipts.items.filter(row=>row.coverageSources.includes('DIRECT')
        &&row.coverageSources.includes('BATCH_RETURN')).length,1);
      await coverage({key:'IMAGE:legacy:88:9201',actor:null,taskId:9201,
        operationKey:'IMAGE:legacy:88:BATCH_RELEASE:SYSTEM',kind:'BATCH_RELEASE',data:{freezeId:88}});
      assert.equal((await repository.personalWorkspace(actors.image,{section:'personal'},true)).qa.IMAGE.processingCoverage,10,
        'system closure cannot be charged to a personal reviewer');
    });

    await t.test('discard and escalation are actual dispositions; two actions on the same item do not create two inspected items',async()=>{
      const common={qaBatchId:900,samplingItemId:9301,reviewItemKey:'COPY:v2:9301'};
      await activity({key:'special-pass:9301',actor:actors.special,taskId:9301,data:common});
      await activity({key:'special-escalate:9301',actor:actors.special,taskId:9301,
        kind:'QA_ESCALATE',outcome:'ESCALATE',data:common});
      await activity({key:'special-discard:9302',actor:actors.special,taskId:9302,
        kind:'QA_DISCARD',outcome:'DISCARD',data:{qaBatchId:900,samplingItemId:9302,reviewItemKey:'COPY:v2:9302'}});
      await activity({key:'special-direct:9303',actor:actors.special,taskId:9303,
        kind:'QA_DIRECT_PASS',data:{qaBatchId:900,samplingItemId:9303}});
      await activity({key:'special-self:9304',actor:actors.special,taskId:9304,
        data:{qaBatchId:900,samplingItemId:9304,exclusion:'SELF_REVIEW'}});
      await activity({key:'special-yesterday:9305',actor:actors.special,taskId:9305,
        offset:'-1 second',data:{qaBatchId:900,samplingItemId:9305}});
      await verifyReceipts(actors.special,'COPY',{actualOperations:2,processingCoverage:2,
        batchReturned:0,batchReleased:0,discarded:1,escalated:1,coverageIncomplete:false});
    });

    await t.test('historical batch count without member scope makes coverage explicitly incomplete',async()=>{
      await activity({key:'legacy-batch-action:9401',actor:actors.legacy,taskId:null,
        kind:'QA_BATCH_RETURN',outcome:null,data:{freezeId:9401,affectedCount:7}});
      await verifyReceipts(actors.legacy,'COPY',{actualOperations:0,processingCoverage:0,
        batchActions:1,coverageIncomplete:true});
    });
  } finally {await repository.pool.end();await database.stop();}
});
