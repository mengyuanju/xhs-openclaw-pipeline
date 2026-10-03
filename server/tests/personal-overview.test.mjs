import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryLedgerQuery } from '../src/delivery-ledger.mjs';
import { readPersonalWorkspace } from '../src/personal-workspace.mjs';

const actor = { userId: 11, username: 'worker', role: 'USER' };
const now = Date.parse('2026-09-29T06:00:00Z');

function overviewFake({ ready = 3, verdicts = [], failure = '' } = {}) {
  const calls = [];
  let released = false;
  const client = { release() { released = true; }, async query(sql, values) {
    calls.push({ sql, values });
    if (failure && sql.includes(failure)) throw new Error('overview facts unavailable');
    if (sql.startsWith('SELECT count(DISTINCT task_id)')) return { rows: [{ ready: String(ready) }] };
    if(sql.includes('SELECT stage,count(*) FILTER(WHERE outcome')) {
      const selected=verdicts.filter(row=>row.account_id===values[0] && row.action==='PASS' && !row.data?.exclusion
        && Date.parse(row.occurred_at)>=Date.parse(values[1]) && Date.parse(row.occurred_at)<Date.parse(values[2]));
      return {rows:['COPY','IMAGE'].map(stage=>({stage,passed:selected.filter(row=>row.stage===stage).length}))};
    }
    if (sql.startsWith('SELECT r.*,EXISTS')) return { rows: [{ id: 1, task_id: 20, stage: 'COPY',
      operator_account_id: actor.userId, first_qa_at: '2026-09-29T02:00:00Z',
      current_bucket: 'FIRST_PASS', data: { outcome: 'PASS' } }] };
    if (sql.startsWith('WITH decisions AS')) return { rows: verdicts.filter(row => row.account_id === values[2]
      && Date.parse(row.occurred_at) >= Date.parse(values[0]) && Date.parse(row.occurred_at) < Date.parse(values[1])) };
    if (['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK'].includes(sql)
      || sql.startsWith('SET LOCAL')) return { rows: [] };
    throw new Error(`Unexpected overview query: ${sql.slice(0, 80)}`);
  } };
  return { pool: { async connect() { return client; } }, calls, get released() { return released; } };
}

function verdict(event_key, stage, action = 'PASS', occurred_at = '2026-09-29T02:00:00Z', account_id = actor.userId) {
  return { event_key, stage, action, occurred_at, account_id, task_id: 7, data: {}, had_return: true };
}

test('top overview stays on Beijing today and counts actual annotator pass verdicts including repeated passes', async t => {
  t.mock.method(Date, 'now', () => now);
  const db = overviewFake({ verdicts: [verdict('copy-first', 'COPY'), verdict('copy-rework', 'COPY'),
    verdict('copy-repeat', 'COPY'), verdict('copy-return', 'COPY', 'RETURN'), verdict('image-pass', 'IMAGE'),
    verdict('old-pass', 'COPY', 'PASS', '2026-09-28T02:00:00Z'),
    verdict('next-day-pass', 'COPY', 'PASS', '2026-09-29T16:00:00Z'),
    verdict('other-annotator', 'COPY', 'PASS', '2026-09-29T02:00:00Z', 99)] });
  const report = await readPersonalWorkspace(db.pool, actor, { section: 'overview', period: 'custom',
    from: 'invalid', to: 'invalid', createdFrom: 'invalid', personalScope: 'CREATED', query: 'other task' }, { report: true });
  assert.deepEqual(report, { section: 'overview', updatedAt: '2026-09-29T06:00:00.000Z', timezone: 'Asia/Shanghai',
    range: { from: '2026-09-29', to: '2026-09-29' },
    delivery: { ready: 3, href: '/delivery-pool?dl_view=CURRENT&dl_state=PENDING&dl_assigneeId=11' },
    passed: { COPY: 3, IMAGE: 1 } });
  assert.equal(db.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(db.calls.at(-1).sql, 'COMMIT');
  assert.equal(db.released, true);
  assert.deepEqual(db.calls.find(call => call.sql.includes('personal_annotation')).values.slice(0, 3),
    [actor.userId,'2026-09-28T16:00:00.000Z', '2026-09-29T16:00:00.000Z']);
  assert.doesNotMatch(JSON.stringify(report), /taskId|query|username|COPY_REVIEW_PENDING/u);
});

test('every role uses personal current delivery visibility and only permitted roles get a delivery link', async t => {
  t.mock.method(Date, 'now', () => now);
  for (const role of ['USER', 'ADMIN', 'REVIEWER']) {
    const currentActor = { ...actor, role }, db = overviewFake();
    const report = await readPersonalWorkspace(db.pool, currentActor, { section: 'overview', period: '30d' }, { report: true });
    const canonical = deliveryLedgerQuery({ view: 'CURRENT', state: 'PENDING' }, { ...currentActor, role: 'USER' });
    const delivery = db.calls.find(call => call.sql.startsWith('SELECT count(DISTINCT task_id)'));
    assert.equal(delivery.sql,
      `SELECT count(DISTINCT task_id)::integer AS ready FROM (${canonical.sql}) personal_delivery`);
    assert.deepEqual(delivery.values, [actor.userId, actor.username]);
    assert.match(delivery.sql, /WHERE assignee\.id=\$1/u);
    assert.match(delivery.sql, /WHERE delivery_state<>'DELIVERED'/u);
    assert.equal(report.delivery.href, role === 'REVIEWER' ? null
      : '/delivery-pool?dl_view=CURRENT&dl_state=PENDING&dl_assigneeId=11');
  }
});

test('refreshing across Beijing midnight resets pass totals without resetting the current delivery count', async t => {
  let current = Date.parse('2026-09-29T15:59:59.999Z');
  t.mock.method(Date, 'now', () => current);
  const db = overviewFake({ verdicts: [verdict('last-today', 'COPY', 'PASS', '2026-09-29T15:59:59.999Z'),
    verdict('first-tomorrow', 'IMAGE', 'PASS', '2026-09-29T16:00:00.000Z')] });
  const before = await readPersonalWorkspace(db.pool, actor, { section: 'overview' }, { report: true });
  current++;
  const after = await readPersonalWorkspace(db.pool, actor, { section: 'overview' }, { report: true });
  assert.deepEqual(before.passed, { COPY: 1, IMAGE: 0 });
  assert.deepEqual(after.passed, { COPY: 0, IMAGE: 1 });
  assert.deepEqual(after.range, { from: '2026-09-30', to: '2026-09-30' });
  assert.equal(before.delivery.ready, after.delivery.ready);
});

test('overview failures roll back and release instead of presenting unavailable counts as zero', async t => {
  t.mock.method(Date, 'now', () => now);
  for (const failure of ['SELECT count(DISTINCT task_id)', 'personal_annotation']) {
    const db = overviewFake({ failure });
    await assert.rejects(readPersonalWorkspace(db.pool, actor, { section: 'overview' }, { report: true }),
      /overview facts unavailable/u);
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
    assert.equal(db.released, true);
  }
});
