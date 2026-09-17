import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import {
  ControlPlaneApiError,
  createControlPlaneClient,
} from '../src/control-plane/client.mjs';

test('task heartbeat responses must partition exactly the requested executions', async () => {
  const id = randomUUID(), input = { nodeId: 'a', executionIds: [id] };
  let payload = { activeExecutionIds: [id], staleExecutionIds: [] };
  const client = createControlPlaneClient({ baseUrl: 'http://localhost', fetchImpl: async (url, options) => {
    assert.ok(url.endsWith('/v1/executions/heartbeat'));
    assert.deepEqual(JSON.parse(options.body), input);
    return Response.json({ data: payload });
  } });
  assert.deepEqual(await client.heartbeatExecutions(input), payload);
  for (const invalid of [null, {}, { activeExecutionIds: {}, staleExecutionIds: [] },
    { activeExecutionIds: [], staleExecutionIds: [] }, { activeExecutionIds: [id], staleExecutionIds: [id] },
    { activeExecutionIds: [randomUUID()], staleExecutionIds: [] }]) {
    payload = invalid;
    await assert.rejects(client.heartbeatExecutions(input), { code: 'INVALID_CONTROL_PLANE_RESPONSE' });
  }
});

test('batch claims preserve request identity and reject malformed or duplicate executions', async () => {
  const requestId = randomUUID();
  const executionId = randomUUID();
  const claim = { task: { id: 1, currentExecutionId: executionId, state: 'COPY_RUNNING' },
    execution: { id: executionId, taskId: 1, nodeId: 'a', kind: 'COPY', status: 'RUNNING', snapshot: {} } };
  let payload = { requestId, claims: [claim] };
  const client = createControlPlaneClient({ baseUrl: 'http://localhost', fetchImpl: async (url, options) => {
    assert.ok(url.endsWith('/claim-copy-batch'));
    assert.deepEqual(JSON.parse(options.body), { nodeId: 'a', requestId, limit: 2 });
    return Response.json({ data: payload });
  } });
  assert.deepEqual(await client.claimCopyBatch({ nodeId: 'a', requestId, limit: 2 }), payload);
  for (const invalid of [null, { requestId, claims: null }, { requestId: randomUUID(), claims: [] },
    { requestId, claims: [null] }, { requestId, claims: [claim, claim] },
    { requestId, claims: [{ ...claim, execution: { ...claim.execution, snapshot: null } }] },
    { requestId, claims: [{ ...claim, task: { ...claim.task, currentExecutionId: randomUUID() } }] },
    { requestId, claims: [{ ...claim, execution: { ...claim.execution, nodeId: 'b' } }] }]) {
    payload = invalid;
    await assert.rejects(client.claimCopyBatch({ nodeId: 'a', requestId, limit: 2 }), { code: 'INVALID_CONTROL_PLANE_RESPONSE' });
  }
});

test('failure reporting preserves explicit no-auto-retry policy on the wire', async () => {
  let body;
  const client = createControlPlaneClient({ baseUrl: 'http://127.0.0.1:4310', fetchImpl: async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: { state: 'IMAGE_FAILED' } }), { headers: { 'Content-Type': 'application/json' } });
  } });
  await client.failExecution('execution', new Error('outcome unknown'), { autoRetry: false });
  assert.deepEqual(body, { error: 'outcome unknown', autoRetry: false });
});

test('control plane client sends image claims only when called', async () => {
  const calls = [];
  const client = createControlPlaneClient({
    baseUrl: 'http://10.0.0.8:4310/',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  await client.registerNode({ nodeId: 'node-a', imageWorkerEnabled: false });
  await client.listNodes();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://10.0.0.8:4310/v1/nodes');
  assert.equal(JSON.parse(calls[0].init.body).imageWorkerEnabled, false);
  assert.equal(calls[1].url, 'http://10.0.0.8:4310/v1/nodes');
  assert.equal(calls[1].init.method, 'GET');
});

test('copy claims accept distributed image-plan work and report its terminal result idempotently', async () => {
  const requestId = randomUUID();
  const executionId = randomUUID();
  const regenerationId = randomUUID();
  const job = {
    id: regenerationId,
    taskId: 7,
    status: 'RUNNING',
    executionId,
    claimedByNodeId: 'copy-a',
  };
  const claim = {
    task: { id: 7, state: 'COPY_REVIEW_PENDING', currentExecutionId: null },
    execution: {
      id: executionId,
      taskId: 7,
      nodeId: 'copy-a',
      kind: 'COPY',
      status: 'RUNNING',
      snapshot: { imagePlanRegeneration: { id: regenerationId } },
    },
    imagePlanRegeneration: job,
  };
  let completionAttempts = 0;
  const seen = [];
  const client = createControlPlaneClient({
    baseUrl: 'http://localhost',
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname;
      seen.push({ path, options });
      if (path.endsWith('/claim-copy-batch')) {
        return Response.json({ data: { requestId, claims: [claim] } });
      }
      if (path.endsWith('/complete-image-plan-regeneration')) {
        completionAttempts += 1;
        if (completionAttempts === 1) throw new TypeError('response lost');
        return Response.json({ data: { ...job, status: 'SUCCEEDED' } });
      }
      if (path.endsWith('/fail-image-plan-regeneration')) {
        return Response.json({ data: { ...job, status: 'FAILED' } });
      }
      assert.fail(`unexpected path ${path}`);
    },
  });
  assert.deepEqual(
    await client.claimCopyBatch({ nodeId: 'copy-a', requestId, limit: 1 }),
    { requestId, claims: [claim] },
  );
  const result = { imagePlan: [], model: 'fake' };
  assert.equal((await client.completeImagePlanRegeneration(executionId, result)).status, 'SUCCEEDED');
  assert.equal(completionAttempts, 2);
  assert.deepEqual(JSON.parse(seen.find(item => item.path.endsWith('/complete-image-plan-regeneration')).options.body), { result });
  assert.equal((await client.failImagePlanRegeneration(executionId, new Error('failed'))).status, 'FAILED');
  assert.deepEqual(JSON.parse(seen.at(-1).options.body), { error: 'failed' });
});

test('image claim and edit transfer protocol carries capability, lease and idempotent result replay',async()=>{
  const requestId=randomUUID(),executionId=randomUUID(),editId=randomUUID(),leaseToken=randomUUID();
  const edit={id:editId,task_id:'7',execution_id:executionId,claimed_by:'image-a',status:'RUNNING',lease_token:leaseToken};
  const claim={task:{id:7,state:'MANUAL_ARCHIVE'},execution:{id:executionId,taskId:7,nodeId:'image-a',kind:'IMAGE',status:'RUNNING',snapshot:{imageEditRequestId:editId}},imageEdit:edit};
  const seen=[];let resultAttempts=0,rejectedAttempts=0;
  const client=createControlPlaneClient({baseUrl:'http://localhost',fetchImpl:async(url,options={})=>{
    const path=new URL(url).pathname;seen.push({path,options});
    if(path.endsWith('/claim-image-batch'))return Response.json({data:{requestId,claims:[claim]}});
    assert.equal(options.headers['X-Image-Edit-Id'],editId);
    assert.equal(options.headers['X-Image-Edit-Lease'],leaseToken);
    if(path.endsWith('/assets/31'))return new Response(Buffer.from('asset'),{headers:{'content-type':'image/png'}});
    if(path.endsWith('/asset-metadata/31'))return Response.json({data:{id:'31',sha256:'a'.repeat(64)}});
    if(path.endsWith('/heartbeat'))return Response.json({data:{active:true}});
    if(path.endsWith('/validation'))return Response.json({data:{passed:true}});
    if(path.endsWith('/rejected-result')){
      rejectedAttempts++;
      if(rejectedAttempts===1)throw new TypeError('response lost');
      assert.deepEqual(Buffer.from(options.body),Buffer.from('rejected-png'));
      return Response.json({data:{assetId:33,imageRunId:randomUUID(),status:'FAILED'}});
    }
    if(path.endsWith('/result')){
      resultAttempts++;
      if(resultAttempts===1)throw new TypeError('response lost');
      assert.deepEqual(Buffer.from(options.body),Buffer.from('png'));
      return Response.json({data:{assetId:32,imageRunId:randomUUID()}});
    }
    if(path.endsWith('/context'))return Response.json({data:{task:{id:7}}});
    assert.fail(`unexpected path ${path}`);
  }});
  assert.deepEqual(await client.claimImageBatch({nodeId:'image-a',requestId,limit:1}),{requestId,claims:[claim]});
  const claimBody=JSON.parse(seen[0].options.body);
  assert.equal(claimBody.imageEditExecutorVersion,8);
  assert.deepEqual(await client.imageEditContext(executionId,edit),{task:{id:7}});
  assert.deepEqual(await client.imageEditAsset(executionId,edit,31),Buffer.from('asset'));
  assert.equal((await client.imageEditAssetMetadata(executionId,edit,31)).sha256,'a'.repeat(64));
  assert.equal(await client.heartbeatImageEdit(executionId,edit),true);
  await client.stageImageEditValidation(executionId,edit,{passed:true});
  assert.equal((await client.completeImageEdit(executionId,edit,Buffer.from('png'))).assetId,32);
  assert.equal(resultAttempts,2);
  assert.equal((await client.rejectImageEdit(executionId,edit,Buffer.from('rejected-png'),Object.assign(new Error('未完成移动'),{validation:{stage:'LOCAL_EDIT_RESULT'}}))).assetId,33);
  assert.equal(rejectedAttempts,2);
  const rejectedValidation=seen.filter(item=>item.path.endsWith('/validation')).at(-1);
  assert.equal(JSON.parse(rejectedValidation.options.body).validation.failureMessage,'未完成移动');
});

test('Xiaohongshu search client authenticates and validates every state-changing response', async () => {
  const leaseToken = randomUUID();
  let payload = {
    id: 5,
    queryPackageItemId: 9,
    taskId: null,
    query: '桌面收纳',
    status: 'RUNNING',
    nodeId: 'host-xhs-search',
    attempt: 1,
    resultLimit: 5,
    searchMode: 'THOROUGH',
    leaseToken,
  };
  const client = createControlPlaneClient({
    baseUrl: 'http://localhost',
    headers: { 'X-XHS-Search-Token': 'machine-secret' },
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers['X-XHS-Search-Token'], 'machine-secret');
      return Response.json({ data: payload });
    },
  });
  assert.equal((await client.claimXhsQuerySearch({ nodeId: 'host-xhs-search' })).id, 5);
  const validClaim = payload;
  for (const resultLimit of [undefined, 0, 11, 1.5, '5']) {
    payload = { ...validClaim, resultLimit };
    await assert.rejects(
      client.claimXhsQuerySearch({ nodeId: 'host-xhs-search' }),
      { code: 'INVALID_CONTROL_PLANE_RESPONSE' },
    );
  }
  for (const searchMode of [undefined, 'QUICK', null]) {
    payload = { ...validClaim, searchMode };
    await assert.rejects(
      client.claimXhsQuerySearch({ nodeId: 'host-xhs-search' }),
      { code: 'INVALID_CONTROL_PLANE_RESPONSE' },
    );
  }
  payload = {
    ...validClaim,
    status: 'SUCCEEDED',
    nodeId: null,
    leaseToken: null,
    resultCount: 1,
    links: [{ noteId: '66f000000000000000000000', url: 'https://www.xiaohongshu.com/explore/66f000000000000000000000', title: null, rank: 1 }],
  };
  assert.equal((await client.completeXhsQuerySearch(5, { leaseToken, links: payload.links })).status, 'SUCCEEDED');
  payload = null;
  await assert.rejects(
    client.failXhsQuerySearch(5, { leaseToken, error: 'network', retryable: true }),
    { code: 'INVALID_CONTROL_PLANE_RESPONSE' },
  );
  payload = { retriedCount: 2 };
  assert.deepEqual(await client.retryFailedXhsQuerySearch({ jobId: 5 }), payload);
  payload = { retriedCount: -1 };
  await assert.rejects(
    client.retryFailedXhsQuerySearch({ jobId: 5 }),
    { code: 'INVALID_CONTROL_PLANE_RESPONSE' },
  );
});

test('claim body timeouts propagate instead of pretending the queue is empty', async () => {
  const timeout = new DOMException('response body timed out', 'TimeoutError');
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:4310',
    fetchImpl: async () => ({
      ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => { throw timeout; },
    }),
  });
  await assert.rejects(client.claimCopy('node-a'), (error) => error === timeout);
});

test('claims reject malformed successful responses but accept an explicit empty queue', async () => {
  for (const body of ['{"data":', '{}', 'null', '<html>unavailable</html>']) {
    const client = createControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4310',
      fetchImpl: async () => new Response(body, {
        headers: { 'Content-Type': body.startsWith('<') ? 'text/html' : 'application/json' },
      }),
    });
    await assert.rejects(client.claimCopy('node-a'), { code: 'INVALID_CONTROL_PLANE_RESPONSE' });
  }
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:4310', fetchImpl: async () => Response.json({ data: null }),
  });
  assert.equal(await client.claimCopy('node-a'), null);
});

test('control plane client surfaces structured stale execution conflicts', async () => {
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:4310',
    fetchImpl: async () => new Response(JSON.stringify({
      error: { code: 'STALE_EXECUTION', message: 'old execution' },
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  await assert.rejects(
    client.updateProgress('d9428888-122b-11e1-b85c-61cd3cbb3210', {
      stage: 'RESEARCH', progressPercent: 25, message: '',
    }),
    (error) => error instanceof ControlPlaneApiError
      && error.status === 409
      && error.code === 'STALE_EXECUTION',
  );
});

test('control plane client supports paged task search, counts, image retry and logical cancellation', async () => {
  const calls = [];
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:4310',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await client.listTasks({
    states: ['COPY_QUEUED', 'COPY_FAILED'],
    nodeId: 'node-a',
    query: '黄山',
    limit: 20,
    offset: 40,
    cursor: 'opaque-cursor',
    includeTotal: true,
  });
  await client.taskCounts('node-a');
  await client.retryImageTask(7);
  await client.cancelTask(7);

  assert.match(calls[0].url, /states=COPY_QUEUED%2CCOPY_FAILED/u);
  assert.match(calls[0].url, /query=%E9%BB%84%E5%B1%B1/u);
  assert.match(calls[0].url, /includeTotal=true/u);
  assert.match(calls[0].url, /cursor=opaque-cursor/u);
  assert.equal(calls[1].url, 'http://127.0.0.1:4310/v1/task-counts?nodeId=node-a');
  assert.equal(calls[2].url, 'http://127.0.0.1:4310/v1/tasks/7/retry-image');
  assert.equal(calls[2].init.method, 'POST');
  assert.equal(calls[3].url, 'http://127.0.0.1:4310/v1/tasks/7/cancel');
  assert.equal(calls[3].init.method, 'POST');
});

test('failure reporting falls back to a bounded message for an older control plane varchar limit', async () => {
  const errors = [];
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:4310',
    fetchImpl: async (_url, init) => {
      const { error } = JSON.parse(init.body);
      errors.push(error);
      const tooLong = [...error].length > 500;
      return new Response(JSON.stringify(tooLong
        ? { error: { code: 'INTERNAL_ERROR', message: 'control plane request failed' } }
        : { data: { state: 'COPY_FAILED' } }), {
        status: tooLong ? 500 : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const message = '联网搜索失败：' + '错误🔍'.repeat(350);
  const result = await client.failExecution('4c8649a9-8c8f-4708-aeb7-2df0a3171a5a', new Error(message));
  assert.equal(result.state, 'COPY_FAILED');
  assert.equal(errors.length, 2);
  assert.equal(errors[0], message);
  assert.ok([...errors[1]].length <= 500);
  assert.ok(errors[1].isWellFormed());
  assert.match(errors[1], /^联网搜索失败/u);
});

test('failure reporting does not retry stale executions or hide other errors', async () => {
  for (const status of [400, 409, 503]) {
    let calls = 0;
    const client = createControlPlaneClient({
      baseUrl: 'http://127.0.0.1:4310',
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: 'TEST_ERROR', message: 'failed' } }), {
          status, headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    await assert.rejects(client.failExecution('execution', new Error('x'.repeat(900))), { status });
    assert.equal(calls, 1);
  }
});
