import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { startTemporaryPostgres18 } from '../server/tests/helpers/personal-postgres.mjs';
import { PostgresControlPlaneRepository } from '../server/src/postgres-repository.mjs';
import { createControlPlaneApp } from '../server/src/http-server.mjs';
import { hashUserPassword } from '../server/src/user-auth.mjs';
import { drainTerminalModelCallPayloadArchive } from '../server/src/model-call-payload-archive.mjs';

async function port() {
  const server = createServer();
  await new Promise(done => server.listen(0,'127.0.0.1',done));
  const value = server.address().port;
  await new Promise(done => server.close(done));
  return value;
}

const database = await startTemporaryPostgres18();
const repository = new PostgresControlPlaneRepository({connectionString:database.connectionString,executionSnapshotStorageEnabled:true});
const storageRoot = await mkdtemp(join(tmpdir(),'xhs-scaling-browser-'));
let app, center, next, browser, page;
const report = {startedAt:new Date().toISOString(),database:'isolated temporary PostgreSQL 18 cluster',modelCalls:0,steps:[],browserErrors:[],httpFailures:[]};
try {
  await repository.initialize();
  const password = `e2e-${randomUUID()}`;
  await repository.pool.query("UPDATE app_users SET password_hash=$1,must_change_password=false WHERE username='admin'",[await hashUserPassword(password)]);
  const admin = await repository.getUserByUsername('admin');
  const headers = {'content-type':'application/json','X-Actor-User-Id':String(admin.id),'X-Actor-Username':'admin','X-Actor-Role':'ADMIN','X-Actor-Credential-Version':String(admin.credentialVersion)};
  app = createControlPlaneApp({repository,storageRoot,storageOptimizationEnabled:false,logger:{info(){},error(line){console.error(line);}},analyzeCopy:async()=>{throw Error('Models forbidden in E2E');},analyzeVisual:async()=>{throw Error('Models forbidden in E2E');}});
  center = await new Promise(done=>{const server=app.listen(0,'127.0.0.1',()=>done(server));});
  const centerUrl = `http://127.0.0.1:${center.address().port}`;
  async function request(path,body,method=body===undefined?'GET':'POST') {
    const response = await fetch(centerUrl+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const result = await response.json();
    assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
    return result.data;
  }
  await request('/v1/nodes',{nodeId:'browser-e2e-node',name:'Synthetic isolated executor',imageWorkerEnabled:true,copyConcurrency:1,imageConcurrency:1});
  await repository.pool.query(`UPDATE workflow_quality_settings SET copy_sampling_enabled=false,image_sampling_enabled=false`);
  await repository.pool.query(`UPDATE global_settings SET value=value-'layoutCatalog' WHERE key='production'`);
  const created = await request('/v1/tasks',{nodeId:'browser-e2e-node',tasks:[{query:'百万规模优化端到端测试专用作业',requestedImageCount:'3'}]});
  const taskId = (Array.isArray(created)?created:created.tasks)[0].id;
  report.taskId=taskId;report.steps.push('Task created through real HTTP');
  const copyClaim = await request('/v1/executions/claim-copy',{nodeId:'browser-e2e-node'});
  assert.equal(copyClaim.task.id,taskId);
  const record = {sequence:1,stage:'TEXT_GENERATION',provider:'synthetic',operation:'TEXT',model:'fake-no-quota',status:'SUCCEEDED',prompt:'合成测试提示词',request:'{}',response:'合成测试返回',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),durationMs:1};
  await request(`/v1/executions/${copyClaim.execution.id}/model-calls/${randomUUID()}`,record,'PUT');
  const copy = {copy:{title:'隔离流程验证',body:'这是独立测试库中的合成测试内容。用于检查查询、分页、权限和交付流程，所有图片均由测试程序创建，不调用任何模型，不涉及真实业务。'.repeat(10).slice(0,500),tags:['#隔离测试','#流程验证','#质量检查']},
    imagePlan:[1,2,3].map((value)=>({kind:value===1?'hero':value===3?'summary':'steps',headline:`测试第${value}页`,subtitle:'合成测试',bullets:['独立测试数据','验证状态一致性'],prompt:'合成测试图片内容说明，不调用模型'}))};
  const completed = await request(`/v1/executions/${copyClaim.execution.id}/complete-copy`,{result:copy});
  assert.equal(completed.task.state,'COPY_REVIEW_PENDING');
  await request(`/v1/tasks/${taskId}/assignee`,{assignedToUserId:'admin',assignedToAccountId:admin.id,reason:'Isolated E2E assignment'},'PATCH');
  const copyTask = await request(`/v1/tasks/${taskId}`);
  const savedDraft = await request(`/v1/tasks/${taskId}/copy-review-drafts`,{
    baseCopyRevisionId:copyTask.currentCopyRevisionId,expectedLatestDraftId:null,
    content:{version:1,draft:{...copy,imageSettings:{version:1,format:'PNG',quality:90,background:'SOLID',backgroundColor:'#ffffff'}},
      aiDisclosureEnabled:false,copyOriginalScore:3,copyOriginalReasons:[],copyOriginalNote:''},
  });
  assert.equal(savedDraft.created,true);
  assert.equal((await request(`/v1/tasks/${taskId}/copy-review-drafts`)).drafts.length,1);
  await request(`/v1/tasks/${taskId}/approve-copy`,{revisionId:copyTask.currentCopyRevisionId,nodeId:'browser-e2e-node',decision:'APPROVE',score:3,reasons:[],reviewSessionId:randomUUID()});
  assert.equal(Number((await repository.pool.query('SELECT count(*) FROM copy_review_drafts WHERE task_id=$1',[taskId])).rows[0].count),1,
    'approved copy retains the draft until final image delivery succeeds');
  report.steps.push('Copy claimed, synthetic completion recorded, assigned and approved');
  const imageClaim = await request('/v1/executions/claim-image',{nodeId:'browser-e2e-node',imageControlsVersion:1,layoutCatalogVersion:0});
  assert.equal(imageClaim.task.id,taskId);
  await request(`/v1/executions/${imageClaim.execution.id}/model-calls/${randomUUID()}`,{...record,operation:'IMAGE',stage:'IMAGE_GENERATION'},'PUT');
  const images=[];
  for(let index=1;index<=3;index++) {
    const bytes=await sharp({create:{width:240,height:320,channels:4,background:{r:50*index,g:100,b:180,alpha:1}}}).png().toBuffer();
    const sha=createHash('sha256').update(bytes).digest('hex');
    const response=await fetch(`${centerUrl}/v1/executions/${imageClaim.execution.id}/assets`,{method:'PUT',headers:{'content-type':'image/png','X-Asset-Sha256':sha,'X-Asset-Name':`synthetic-${index}.png`},body:bytes});
    const result=await response.json();assert.ok(response.ok,JSON.stringify(result));
    images.push({page:index,assetId:result.data.id});
  }
  await request(`/v1/executions/${imageClaim.execution.id}/complete-image`,{result:{imageControlsVersion:1,images}});
  assert.equal((await request(`/v1/tasks/${taskId}`)).state,'MANUAL_ARCHIVE');
  const review=await request(`/v1/tasks/${taskId}/submit-image-self-review`,{imageRunId:imageClaim.execution.id,score:3,reasons:[],problemAssetIds:[],reviewSessionId:randomUUID()});
  report.steps.push('Image claimed, 3 synthetic PNGs uploaded and image self review submitted');
  assert.equal((await request(`/v1/tasks/${taskId}`)).state,'REVIEWED',JSON.stringify(review));
  assert.deepEqual((await request(`/v1/tasks/${taskId}/copy-review-drafts`)).drafts,[]);
  assert.equal(Number((await repository.pool.query('SELECT count(*) FROM copy_review_drafts WHERE task_id=$1',[taskId])).rows[0].count),0);
  assert.equal(Number((await repository.pool.query('SELECT count(*) FROM task_executions WHERE task_id=$1',[taskId])).rows[0].count),2);
  report.steps.push('Saved review draft survives copy approval and is removed atomically at final delivery; execution history remains');
  for(let attempt=0;attempt<50;attempt++) {
    const calls=await request(`/v1/tasks/${taskId}/model-calls`);
    if(calls.cleanup?.status==='COMPLETE'){assert.equal(calls.total,0);report.steps.push('Delivery cleanup complete; no model trace remained');break;}
    if(attempt===49) throw Error('Cleanup did not complete');
    await new Promise(done=>setTimeout(done,100));
  }
  const delivery=await request('/v1/delivery-pool?limit=20&includeTotal=true');
  assert.ok(delivery.items.some(item=>item.taskId===taskId));
  // A historical synthetic run exercises the lazy image comparator without model calls.
  const oldRunId=randomUUID();
  await repository.pool.query(`INSERT INTO image_runs(id,task_id,execution_id,copy_revision_id,status,result,finished_at,created_at,image_production_chain_id)
    SELECT $1,task_id,NULL,copy_revision_id,'COMPLETED',result,finished_at,created_at-interval '10 minutes',image_production_chain_id
    FROM image_runs WHERE id=$2`,[oldRunId,imageClaim.execution.id]);
  await repository.pool.query(`INSERT INTO image_run_asset_members(image_run_id,asset_id)
    SELECT $1,id FROM assets WHERE image_run_id=$2`,[oldRunId,imageClaim.execution.id]);
  const storageQuery='历史正文压缩端到端测试专用作业';
  const storageCreated=await request('/v1/tasks',{nodeId:'browser-e2e-node',tasks:[{query:storageQuery,requestedImageCount:'3'}]});
  const storageTaskId=(Array.isArray(storageCreated)?storageCreated:storageCreated.tasks)[0].id;
  const storageClaim=await request('/v1/executions/claim-copy',{nodeId:'browser-e2e-node'});
  assert.equal(storageClaim.task.id,storageTaskId);
  const storedSnapshot=(await repository.pool.query('SELECT * FROM task_executions WHERE id=$1',[storageClaim.execution.id])).rows[0];
  assert.ok(storedSnapshot.snapshot_prompts_hash);
  assert.equal(Object.hasOwn(storedSnapshot.snapshot,'prompts'),false);
  assert.ok(storageClaim.execution.snapshot.prompts);
  const storageCallId=randomUUID(),oldFinished=new Date(Date.now()-14*86400_000).toISOString();
  const storageRecord={...record,prompt:'压缩前后保持完整的提示词。'.repeat(600),
    request:JSON.stringify({synthetic:true,message:'仅验证存储与读取，不调用模型'}),
    response:'完整历史返回内容。'.repeat(600),startedAt:oldFinished,finishedAt:oldFinished};
  await request(`/v1/executions/${storageClaim.execution.id}/model-calls/${storageCallId}`,storageRecord,'PUT');
  await request(`/v1/executions/${storageClaim.execution.id}/complete-copy`,{result:copy});
  await request(`/v1/tasks/${storageTaskId}/assignee`,{assignedToUserId:'admin',assignedToAccountId:admin.id,reason:'Isolated cold payload E2E'},'PATCH');
  await repository.pool.query('UPDATE task_executions SET finished_at=$2 WHERE id=$1',[storageClaim.execution.id,oldFinished]);
  const storageBefore=await request(`/v1/tasks/${storageTaskId}/model-calls/${storageCallId}`);
  const archived=await drainTerminalModelCallPayloadArchive(repository.pool);
  assert.equal(archived.archived,1);
  assert.deepEqual(await request(`/v1/tasks/${storageTaskId}/model-calls/${storageCallId}`),storageBefore);
  assert.deepEqual((await request(`/v1/tasks/${storageTaskId}`)).executions[0].snapshot,storageClaim.execution.snapshot);
  report.steps.push('New execution stores shared config references; HTTP restores full snapshot and compressed historical model details exactly');
  await request('/v1/personal-workspace/tasks?limit=50');
  const webPort=await port(),origin=`http://127.0.0.1:${webPort}`;
  next=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p',String(webPort)],{
    shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'production',XHS_NEXT_DIST_DIR:'.next-scaling-e2e',CONTROL_PLANE_URL:centerUrl,XHS_SESSION_SECRET:randomUUID()+randomUUID(),XHS_PREVIEW_BASE_URL:'',PREVIEW_BASE_URL:'',PREVIEW_API_KEY:'',DATABASE_URL:database.connectionString},
  });
  let nextOutput='';next.stdout.on('data',chunk=>{nextOutput=(nextOutput+chunk).slice(-10000);});next.stderr.on('data',chunk=>{nextOutput=(nextOutput+chunk).slice(-10000);});
  for(let attempt=0;attempt<100;attempt++) {
    if(next.exitCode!==null)throw Error(`Next stopped: ${nextOutput}`);
    if(await fetch(origin+'/login').then(response=>response.ok,()=>false))break;
    if(attempt===99)throw Error(`Next did not start: ${nextOutput}`);
    await new Promise(done=>setTimeout(done,200));
  }
  browser=await chromium.launch({channel:'msedge',headless:true});
  page=await browser.newPage({viewport:{width:1440,height:1100}});
  page.on('pageerror',error=>report.browserErrors.push(error.message));
  page.on('response',response=>{if(response.url().startsWith(origin+'/api/')&&response.status()>=400)report.httpFailures.push({url:new URL(response.url()).pathname,status:response.status()});});
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin+'/login');
  await page.getByLabel('账号',{exact:true}).fill('admin');await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'进入后台',exact:true}).click();
  await page.waitForURL('**/workbench/personal');
  await page.getByRole('button',{name:`查看作业 #${taskId}：百万规模优化端到端测试专用作业`,exact:true}).click();
  await page.getByRole('button',{name:/模型调用链路/}).click();
  await page.getByText(/交付前的模型调用记录已按策略清理/).waitFor();
  assert.equal(await page.locator('.model-call-card').count(),0);
  await page.getByRole('button',{name:/历史版本与审核记录/}).click();
  await page.getByRole('button',{name:/文案版本 · 第 1 版/}).click();
  await page.getByText('隔离流程验证',{exact:true}).waitFor();
  await page.getByRole('button',{name:'历史图片 · 对照当前成品',exact:true}).click();
  await page.getByText('历史第 1 张',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('查看历史版本',{exact:true}).inputValue(),oldRunId);
  report.steps.push('Real production Next build: browser login, personal page, current task, cleanup notice and lazy history');
  await page.goto(origin+'/workbench/personal');
  await page.getByRole('button',{name:`查看作业 #${storageTaskId}：${storageQuery}`,exact:true}).click();
  await page.getByRole('button',{name:/模型调用链路/}).click();
  await page.getByRole('button',{name:/第 1 步 · 文案生成/}).click();
  await page.getByRole('button',{name:'完整提示词原文（已脱敏）',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.model-call-card pre')?.textContent?.includes('压缩前后保持完整的提示词。'));
  await page.getByRole('button',{name:'原文',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.model-response-raw')?.textContent?.includes('完整历史返回内容。'));
  assert.equal(await page.locator('.model-response-raw').textContent(),storageBefore.response);
  report.steps.push('Browser opens archived model call and displays restored request, prompt and response through the unchanged page');
  await page.goto(origin+'/reports/task-data');
  await page.getByRole('button',{name:'生成任务明细 CSV',exact:true}).click();
  const downloadLink=page.getByRole('link',{name:'下载 CSV',exact:true}).first();
  await downloadLink.waitFor();
  const downloaded=page.waitForEvent('download');await downloadLink.click();
  const download=await downloaded;
  const csv=await readFile(await download.path(),'utf8');
  assert.match(csv,/百万规模优化端到端测试专用作业/);
  report.steps.push('Persistent background CSV export generated and downloaded through the browser');
  await page.goto(origin+'/workbench-statistics');
  await page.getByText('工作量与趋势',{exact:true}).click();
  await page.getByRole('button',{name:/文案标注：.*查看明细/}).click();
  await page.getByRole('dialog').getByText('共 1 条事件。',{exact:false}).waitFor();
  await page.getByRole('tab',{name:'趋势与待办',exact:true}).click();
  await page.getByRole('heading',{name:'当前标注待办',exact:true}).waitFor();
  assert.equal(await page.getByRole('dialog').getByRole('alert').count(),0);
  await page.goto(origin+'/reports/annotation-jobs');
  await page.getByRole('heading',{name:'标注作业统计报表',exact:true}).waitFor();
  await page.getByRole('button',{name:'刷新',exact:true}).waitFor();
  await page.getByRole('img',{name:/总作业每日趋势/}).waitFor();
  assert.equal(await page.getByRole('alert').filter({hasText:/失败|错误|无效|超时/}).count(),0);
  report.steps.push('Personnel summary, paged detail and annotation-job report opened through the browser');
  await mkdir(resolve('reports'),{recursive:true});
  await page.screenshot({path:resolve('reports/scaling-browser-e2e.png'),fullPage:true});
  assert.deepEqual(report.browserErrors,[]);assert.deepEqual(report.httpFailures,[]);
  report.passed=true;
} catch(error) {
  report.passed=false;report.failure=error.stack;
  if(page)await page.screenshot({path:resolve('reports/scaling-browser-e2e-failure.png'),fullPage:true}).catch(()=>{});
  throw error;
} finally {
  report.completedAt=new Date().toISOString();await mkdir(resolve('reports'),{recursive:true});
  await writeFile(resolve('reports/scaling-browser-e2e.json'),JSON.stringify(report,null,2));
  await browser?.close();
  if(next&&next.exitCode===null){next.kill();await new Promise(done=>next.once('exit',done));}
  if(center)await new Promise(done=>center.close(done));
  await app?.context.disposeControlPlaneResources?.();await repository.pool.end();await database.stop();
  assert.ok(resolve(storageRoot).startsWith(resolve(tmpdir())+'\\')||resolve(storageRoot).startsWith(resolve(tmpdir())+'/'));
  await rm(storageRoot,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
console.log(JSON.stringify(report));
