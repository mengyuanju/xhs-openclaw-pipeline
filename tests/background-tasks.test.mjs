import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { backgroundTaskGroup, backgroundTaskMessage, createBackgroundTaskStore, isPlanSourceCurrent } from '../app/components/background-task-store.ts';

const account = { accountUsername: 'worker', accountId: 22 };

function ownedSnapshot(path, snapshot, identity = account) {
  const owner = path.includes('/regenerate-image-plan/')
    ? { requestedByUsername: identity.accountUsername, requestedByAccountId: identity.accountId }
    : { created_by: identity.accountUsername, created_by_account_id: identity.accountId };
  return { ...owner, ...snapshot };
}

function fixture(request = async () => ({ status: 'SUCCEEDED' }), { attachOwner = true, ...identity } = {}) {
  const saved = new Map(), notifications = [];
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const activeAccount = { ...account, ...identity };
  const options = { storage, storageKey: 'account:one', ...activeAccount,
    request: async path => {
      const snapshot = await request(path);
      return attachOwner ? ownedSnapshot(path, snapshot, activeAccount) : snapshot;
    },
    onComplete: task => notifications.push(task) };
  return { saved, notifications, options, store: createBackgroundTaskStore(options) };
}
const plan = () => ({ id: randomUUID(), kind: 'IMAGE_PLAN', taskId: 10, status: 'QUEUED',
  ownerUsername: account.accountUsername, ownerAccountId: account.accountId });
const legacyTask = overrides => {
  const { ownerUsername: _username, ownerAccountId: _accountId, ...task } = plan();
  return { ...task, createdAt: Date.now(), read: false, ...overrides };
};

test('tabs merge completion, read and consumed state without repeating completion or losing new tasks', async () => {
  const f = fixture();
  const second = createBackgroundTaskStore(f.options);
  const a = plan(), b = plan();
  f.store.track(a); second.track(b);
  f.store.sync(); assert.equal(f.store.getSnapshot().length, 2);
  await f.store.poll(); await second.poll();
  assert.equal(f.notifications.length, 2, 'each job only notifies once across tabs');
  second.markRead(a.id); f.store.consumePlan(a.id); second.sync();
  assert.equal(second.getSnapshot().find(task => task.id === a.id).consumed, true);
  second.markAllRead(); f.store.sync();
  assert.ok(f.store.getSnapshot().every(task => task.read));
  assert.equal(backgroundTaskGroup(f.store.getSnapshot().find(task => task.id === b.id)), 'ready', 'read does not mean adopted');
  second.track(a, true); f.store.sync();
  assert.equal(f.store.getSnapshot().find(task => task.id === a.id).status, 'QUEUED');
  assert.equal(f.store.getSnapshot().find(task => task.id === a.id).consumed, undefined);
});

test('delayed storage events repair overlapping writes; stale completion cannot undo retry', async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const a = plan(), b = plan();
  f.store.track(a);
  const firstWrite = f.saved.get('account:one');
  const pending = f.store.poll();
  const second = createBackgroundTaskStore(f.options);
  second.track(a, true); second.track(b);
  const latest = f.saved.get('account:one');
  f.saved.set('account:one', firstWrite); // Simulate a racing stale write.
  f.store.sync(latest);
  second.sync();
  release({ status: 'SUCCEEDED' }); await pending;
  assert.equal(f.notifications.length, 0);
  assert.equal(f.store.getSnapshot().find(task => task.id === a.id).status, 'QUEUED');
  assert.equal(JSON.parse(f.saved.get('account:one')).length, 2);
});

test('mark all read preserves running jobs and preview polling notices adoption', async () => {
  let status = 'PREVIEW_READY';
  const f = fixture(async () => ({ status }));
  const running = plan(), ready = { ...plan(), kind: 'IMAGE_EDIT', status };
  f.store.track(running); f.store.track(ready); f.store.markAllRead();
  assert.equal(f.store.getSnapshot().find(task => task.id === running.id).read, false);
  assert.equal(backgroundTaskGroup(f.store.getSnapshot().find(task => task.id === ready.id)), 'ready');
  status = 'ACCEPTED'; await f.store.poll();
  assert.equal(backgroundTaskGroup(f.store.getSnapshot().find(task => task.id === ready.id)), 'history');
});

test('background monitoring survives closed UI, restores after reload, and notifies once', async () => {
  const f = fixture();
  const job = plan();
  f.store.track(job);
  const unsubscribe = f.store.subscribe(() => {});
  unsubscribe(); // The initiating dialog can disappear without stopping the monitor.
  f.store.stop();
  const restored = createBackgroundTaskStore(f.options);
  await restored.poll();
  await restored.poll();
  assert.equal(f.notifications.length, 1);
  assert.equal(restored.getSnapshot()[0].status, 'SUCCEEDED');
  restored.markRead(job.id);
  assert.equal(restored.getSnapshot()[0].read, true);
  const again = createBackgroundTaskStore(f.options);
  await again.poll(); // Retrieve a completed plan's result without repeating its toast.
  assert.equal(f.notifications.length, 1);
  assert.deepEqual(again.getSnapshot()[0].payload, { status: 'SUCCEEDED', requestedByUsername: 'worker', requestedByAccountId: 22 });
  again.consumePlan(job.id);
  assert.equal(createBackgroundTaskStore(f.options).getSnapshot()[0].consumed, true);
  assert.equal(createBackgroundTaskStore({ ...f.options, storageKey: 'account:two' }).getSnapshot().length, 0);
});

test('temporary polling errors retain running status and recover independently of other tasks', async () => {
  let offline = true;
  const a = plan(), b = { ...plan(), kind: 'IMAGE_EDIT', taskId: 11, page: 2 };
  const f = fixture(async path => {
    if (path.endsWith(a.id) && offline) throw new Error('network unavailable');
    return { status: path.endsWith(b.id) ? 'PREVIEW_READY' : 'FAILED', error: '执行机失败' };
  });
  f.store.track(a); f.store.track(b);
  await f.store.poll();
  const pending = f.store.getSnapshot().find(task => task.id === a.id);
  assert.equal(pending.status, 'QUEUED');
  assert.match(backgroundTaskMessage(pending), /自动重连/u);
  assert.equal(f.notifications.length, 1);
  assert.match(backgroundTaskMessage(f.notifications[0]), /检查并采用/u);
  offline = false;
  await f.store.poll(); await f.store.poll();
  assert.equal(f.notifications.length, 2);
  assert.equal(f.notifications[1].error, '执行机失败');
});

test('image-edit preflight warnings stay in history without taskbar notifications', async () => {
  const sourceId = randomUUID(), targetId = randomUUID();
  const errors = new Map([
    [sourceId, '源图视觉验收不确定或必需文字缺失，不能安全编辑'],
    [targetId, '产品 1 的目标或参考图预检失败：真实产品替换前置检查未通过，尚未调用图片编辑模型：目标含持握手指'],
  ]);
  const f = fixture(async path => ({ status: 'FAILED', error: errors.get(path.split('/').at(-1)) }));
  for (const id of [sourceId, targetId]) f.store.track({ ...plan(), id, kind: 'IMAGE_EDIT', status: 'QUEUED' });
  await f.store.poll();
  assert.equal(f.notifications.length, 0);
  assert.ok(f.store.getSnapshot().every(task => task.read));
  assert.ok(f.store.getSnapshot().every(task => backgroundTaskGroup(task) === 'history'));
  const restored = createBackgroundTaskStore(f.options);
  assert.ok(restored.getSnapshot().every(task => task.read), 'legacy preflight failures remain acknowledged after reload');
});

test('retries notify again while duplicate registration and overlapping polls do not', async () => {
  let release, count = 0;
  const f = fixture(() => { count++; return new Promise(resolve => { release = resolve; }); });
  const job = { ...plan(), kind: 'IMAGE_EDIT' };
  f.store.track(job); f.store.track(job);
  const pending = f.store.poll();
  await f.store.poll();
  assert.equal(count, 1);
  release({ status: 'FAILED' }); await pending;
  f.store.track(job, true);
  const retry = f.store.poll(); release({ status: 'PREVIEW_READY' }); await retry;
  assert.equal(f.notifications.length, 2);
  assert.equal(f.store.getSnapshot().length, 1);
});

test('cancel or retry supersedes an in-flight response; stopped account never receives a notification', async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const job = { ...plan(), kind: 'IMAGE_EDIT' };
  f.store.track(job);
  const pending = f.store.poll();
  f.store.track({ ...job, status: 'CANCELLED' }, true);
  release({ status: 'PREVIEW_READY' }); await pending;
  assert.equal(f.store.getSnapshot()[0].status, 'CANCELLED');
  assert.equal(f.notifications.length, 1);
  f.store.track(job, true);
  const stopped = f.store.poll(); f.store.stop();
  release({ status: 'PREVIEW_READY' }); await stopped;
  assert.equal(f.notifications.length, 1);
});

test('permanent access failures stop polling and malformed saved records are ignored', async () => {
  let requests = 0;
  const f = fixture(async () => { requests++; throw Object.assign(new Error('removed'), { status: 404 }); });
  f.store.track(plan()); await f.store.poll(); await f.store.poll();
  assert.equal(requests, 1);
  assert.equal(f.store.getSnapshot()[0].status, 'UNAVAILABLE');
  f.saved.set('account:one', '[{"id":"../../bad","kind":"IMAGE_PLAN","taskId":10,"status":"RUNNING","read":false,"createdAt":1}]');
  assert.equal(createBackgroundTaskStore(f.options).getSnapshot().length, 0);
});

test('restored planning results match the exact source revision and copy regardless of object key order', () => {
  const copy = { title: '标题', body: '正文', tags: ['#标签'] };
  const job = { copyRevisionId: 20, copy: { body: copy.body, tags: copy.tags, title: copy.title } };
  assert.equal(isPlanSourceCurrent(job, 20, copy), true);
  assert.equal(isPlanSourceCurrent(job, 21, copy), false);
  assert.equal(isPlanSourceCurrent(job, 20, { ...copy, body: '新正文' }), false);
  assert.equal(isPlanSourceCurrent(job, 20, { ...copy, tags: ['#新标签'] }), false);
});


test('standalone edit notifications poll their own API and persist without becoming business tasks',async()=>{
  const paths=[];
  const f=fixture(async path=>{paths.push(path);return {status:'PREVIEW_READY'};});
  const job={...plan(),taskId:51,kind:'STANDALONE_IMAGE_EDIT'};
  f.store.track(job);await f.store.poll();
  assert.deepEqual(paths,[`/v1/image-editor/edits/${job.id}`]);
  assert.equal(f.notifications.length,1);
  assert.equal(createBackgroundTaskStore(f.options).getSnapshot()[0].kind,'STANDALONE_IMAGE_EDIT');
});


test('deleting standalone workspaces clears every tracked page and fences late poll responses across tabs', async () => {
  for (const outcome of ['success','missing']) {
    let resolvePoll,rejectPoll;
    const f=fixture(()=>new Promise((resolve,reject)=>{resolvePoll=resolve;rejectPoll=reject;}));
    const a={...plan(),kind:'STANDALONE_IMAGE_EDIT',taskId:498};
    const b={...a,id:randomUUID(),page:2,status:'PREVIEW_READY'};
    const business={...plan(),kind:'IMAGE_EDIT',taskId:498,status:'ACCEPTED'};
    f.store.track(a);f.store.track(b);f.store.track(business);f.notifications.length=0;
    // Only one request needs to remain in flight for this race.
    const options={...f.options,request:path=>path.endsWith(a.id)?f.options.request(path):Promise.resolve(ownedSnapshot(path,{status:'PREVIEW_READY'}))};
    const polling=createBackgroundTaskStore(options);
    const pending=polling.poll();
    const stale=f.saved.get('account:one');
    f.store.dismissStandaloneWorkspaces([498,999]);
    if(outcome==='success')resolvePoll({status:'PREVIEW_READY'});
    else rejectPoll(Object.assign(new Error('removed'),{status:404}));
    await pending;
    f.saved.set('account:one',stale); // A delayed tab overwrites localStorage after deletion.
    polling.sync(stale);
    assert.equal(f.notifications.length,0,'deletion and late responses do not notify');
    assert.ok(polling.getSnapshot().filter(task=>task.kind==='STANDALONE_IMAGE_EDIT').every(task=>task.status==='DELETED'&&task.read));
    assert.equal(polling.getSnapshot().find(task=>task.id===business.id).status,'ACCEPTED');
    polling.track(a,true);
    assert.equal(polling.getSnapshot().find(task=>task.id===a.id).status,'DELETED','stale restart cannot resurrect a deleted request');
    const restored=createBackgroundTaskStore({...f.options,request:()=>assert.fail('deleted tasks must not be polled')});
    await restored.poll();
  }
});

test('server deletion receipts silently clear cached unavailable and ready standalone notifications',async()=>{
  const f=fixture(async()=>({status:'DELETED'}));
  const a={...plan(),kind:'STANDALONE_IMAGE_EDIT',status:'UNAVAILABLE'};
  const b={...a,id:randomUUID(),status:'PREVIEW_READY'};
  f.store.track(a);f.store.track(b);f.notifications.length=0;
  const restored=createBackgroundTaskStore(f.options);
  await restored.poll();await restored.poll();
  assert.ok(restored.getSnapshot().every(task=>task.status==='DELETED'&&task.read));
  assert.equal(f.notifications.length,0);
});

test('standalone permission failures still notify once and cached unavailability is only rechecked once',async()=>{
  let calls=0;
  const f=fixture(async()=>{calls++;throw Object.assign(new Error('forbidden'),{status:403});});
  f.store.track({...plan(),kind:'STANDALONE_IMAGE_EDIT'});
  await f.store.poll();await f.store.poll();await f.store.poll();
  assert.equal(calls,2);assert.equal(f.notifications.length,1);
  assert.equal(f.store.getSnapshot()[0].status,'UNAVAILABLE');
});

test('foreign background requests cannot be imported even by an administrator or a reused username', async () => {
  for (const identity of [account, { accountUsername: 'admin', accountId: 1 }]) {
    const f = fixture(() => assert.fail('foreign requests must not be polled'), identity);
    const foreign = { ...plan(), kind: 'IMAGE_EDIT', taskId: 429, page: 4, status: 'PREVIEW_READY',
      ownerUsername: 'another-user', ownerAccountId: 33 };
    f.store.track(foreign);
    f.store.track(foreign, true);
    f.store.track({ ...foreign, id: randomUUID(), ownerUsername: identity.accountUsername,
      ownerAccountId: identity.accountId + 1 });
    f.store.track(legacyTask({ kind: 'IMAGE_EDIT', taskId: 429, page: 4, status: 'PREVIEW_READY' }));
    await f.store.poll();
    assert.equal(f.store.getSnapshot().length, 0);
    assert.equal(f.notifications.length, 0);
  }
});

test('saved foreign owner metadata is discarded quietly before it can appear as personal history', async () => {
  const f = fixture(() => assert.fail('known foreign records must not be polled'));
  const records = [
    { ...plan(), kind: 'IMAGE_EDIT', taskId: 429, page: 4, status: 'PREVIEW_READY',
      ownerUsername: 'another-user', ownerAccountId: 33 },
    { ...plan(), status: 'SUCCEEDED', ownerAccountId: 23 },
  ].map(task => ({ ...task, createdAt: Date.now(), read: false, payload: { private: true }, error: 'private error' }));
  f.saved.set('account:one', JSON.stringify(records));
  const restored = createBackgroundTaskStore(f.options);
  assert.equal(restored.getSnapshot().length, 2, 'rejected IDs remain as deletion fences');
  assert.ok(restored.getSnapshot().every(task => task.status === 'DELETED' && task.read && !task.payload && !task.error));
  assert.ok(JSON.parse(f.saved.get('account:one')).every(task => task.status === 'DELETED'));
  await restored.poll();
  assert.equal(f.notifications.length, 0);
});

test('legacy completed and unavailable entries stay hidden until ownership is recovered without repeating a toast', async () => {
  const records = [
    legacyTask({ status: 'SUCCEEDED' }),
    legacyTask({ kind: 'IMAGE_EDIT', status: 'ACCEPTED', read: true }),
    legacyTask({ kind: 'STANDALONE_IMAGE_EDIT', status: 'UNAVAILABLE', read: true }),
  ];
  const statuses = new Map(records.map(task => [task.id, task.status]));
  const calls = [];
  const f = fixture(async path => {
    calls.push(path);
    return { status: statuses.get(path.split('/').at(-1)) };
  });
  f.saved.set('account:one', JSON.stringify(records));
  const restored = createBackgroundTaskStore(f.options);
  assert.deepEqual(restored.getSnapshot(), []);
  await restored.poll();
  assert.equal(calls.length, records.length, 'terminal and unavailable legacy records are validated too');
  for (const original of records) {
    const recovered = restored.getSnapshot().find(task => task.id === original.id);
    assert.equal(recovered.ownerUsername, 'worker');
    assert.equal(recovered.ownerAccountId, 22);
    assert.equal(recovered.status, original.status);
    assert.equal(recovered.read, original.read);
  }
  await restored.poll();
  assert.equal(calls.length, records.length);
  const reloaded = createBackgroundTaskStore(f.options);
  assert.equal(reloaded.getSnapshot().length, records.length);
  await reloaded.poll();
  assert.equal(f.notifications.length, 0, 'restoring completed work does not reannounce completion');
});

test('legacy foreign, unidentified and forbidden terminal entries are hidden and silently removed', async () => {
  const foreignPlan = legacyTask({ status: 'SUCCEEDED' });
  const reusedUsername = legacyTask({ kind: 'IMAGE_EDIT', taskId: 429, page: 4, status: 'ACCEPTED' });
  const unidentified = legacyTask({ kind: 'IMAGE_EDIT', status: 'FAILED' });
  const forbidden = legacyTask({ kind: 'STANDALONE_IMAGE_EDIT', status: 'UNAVAILABLE' });
  const missing = legacyTask({ kind: 'IMAGE_EDIT', status: 'CANCELLED' });
  const records = [foreignPlan, reusedUsername, unidentified, forbidden, missing];
  const responses = new Map([
    [foreignPlan.id, { status: 'SUCCEEDED', requestedByUsername: 'another-user', requestedByAccountId: 33 }],
    [reusedUsername.id, { status: 'ACCEPTED', created_by: 'worker', created_by_account_id: 23 }],
    [unidentified.id, { status: 'FAILED' }],
  ]);
  let calls = 0;
  const f = fixture(async path => {
    calls++;
    const id = path.split('/').at(-1);
    if (id === forbidden.id || id === missing.id) {
      throw Object.assign(new Error('unavailable'), { status: id === forbidden.id ? 403 : 404 });
    }
    return responses.get(id);
  }, { attachOwner: false });
  f.saved.set('account:one', JSON.stringify(records));
  const restored = createBackgroundTaskStore(f.options);
  assert.deepEqual(restored.getSnapshot(), [], 'no legacy terminal history is rendered before validation');
  await restored.poll();
  assert.equal(calls, records.length);
  assert.ok(restored.getSnapshot().every(task => task.status === 'DELETED' && task.read && !task.payload && !task.error));
  assert.equal(restored.getSnapshot().filter(task => task.status !== 'DELETED').length, 0);
  await restored.poll();
  assert.equal(calls, records.length, 'rejected legacy IDs stop polling');
  assert.equal(f.notifications.length, 0);
});

test('cross-tab stale cache writes and explicit retries cannot resurrect an ownership-rejected request', async () => {
  const legacy = legacyTask({ kind: 'IMAGE_EDIT', taskId: 429, page: 4, status: 'PREVIEW_READY' });
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { status: 'PREVIEW_READY', created_by: 'another-user', created_by_account_id: 33 };
  }, { attachOwner: false });
  const stale = JSON.stringify([legacy]);
  f.saved.set('account:one', stale);
  const second = createBackgroundTaskStore(f.options);
  await f.store.poll();
  const rejected = f.saved.get('account:one');
  f.saved.set('account:one', stale); // A delayed tab writes the old unverified cache.
  second.sync(rejected); // The deletion storage event must repair that write.
  f.store.sync(stale);
  const retry = { ...legacy, ownerUsername: 'worker', ownerAccountId: 22, status: 'QUEUED' };
  f.store.track(retry, true);
  second.track(retry, true);
  await f.store.poll(); await second.poll();
  for (const store of [f.store, second, createBackgroundTaskStore(f.options)]) {
    assert.equal(store.getSnapshot()[0].status, 'DELETED');
  }
  assert.equal(JSON.parse(f.saved.get('account:one'))[0].status, 'DELETED');
  assert.equal(calls, 1);
  assert.equal(f.notifications.length, 0);
});

test('foreign or incomplete poll ownership cannot turn an owned running request into a completion notification', async () => {
  const jobs = [plan(), { ...plan(), kind: 'IMAGE_EDIT' }, { ...plan(), kind: 'STANDALONE_IMAGE_EDIT' },
    { ...plan(), kind: 'IMAGE_EDIT' }];
  const responses = new Map([
    [jobs[0].id, { status: 'SUCCEEDED', requestedByUsername: 'worker', requestedByAccountId: 23 }],
    [jobs[1].id, { status: 'PREVIEW_READY', created_by: 'another-user', created_by_account_id: 33, preview_path: 'private.png' }],
    [jobs[2].id, { status: 'PREVIEW_READY', created_by: 'worker', created_by_account_id: null }],
    [jobs[3].id, { status: 'FAILED', error: 'private error' }],
  ]);
  let calls = 0;
  const f = fixture(async path => { calls++; return responses.get(path.split('/').at(-1)); }, { attachOwner: false });
  for (const job of jobs) f.store.track(job);
  assert.equal(f.store.getSnapshot().length, jobs.length);
  await f.store.poll(); await f.store.poll();
  assert.ok(f.store.getSnapshot().every(task => task.status === 'DELETED' && task.read && !task.payload && !task.error));
  assert.equal(calls, jobs.length);
  assert.equal(f.notifications.length, 0);
});
