import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createImageQualityTailDrain } from '../src/image-quality-tail-flush.mjs';
import { startTemporaryPostgres18 } from './temporary-postgres18.mjs';

test('real PostgreSQL tail pagination agrees with a complete scoped sampling oracle', {
  skip: process.env.RUN_POSTGRES_E2E !== '1', timeout: 120_000,
}, async t => {
  const postgres = await startTemporaryPostgres18('xhs-image-tail-oracle-');
  const pool = new pg.Pool({ connectionString: postgres.connectionString });
  t.after(async () => { await pool.end(); await postgres.stop(); });
  await pool.query(`
    CREATE TABLE app_users(id bigint PRIMARY KEY, display_name text);
    CREATE TABLE tasks(id bigint PRIMARY KEY, state text, production_batch_id bigint,
      current_copy_revision_id bigint, current_image_run_id text,
      priority_sort_at timestamptz, priority_paused boolean);
    CREATE TABLE image_runs(id text PRIMARY KEY, task_id bigint);
    CREATE TABLE image_approval_events(id bigint PRIMARY KEY, task_id bigint,
      copy_revision_id bigint, image_run_id text, submitted_at timestamptz,
      submitted_by_account_id bigint, submitted_by_username text);
    CREATE TABLE image_sampling_items(id bigserial PRIMARY KEY, task_id bigint,
      approval_event_id bigint, image_run_id text, selected boolean,
      status text, submitter_account_id bigint, submitter_username text);
    INSERT INTO app_users VALUES (1, 'Alice Smith'), (2, 'Own reviewer'), (3, 'Bob Jones');
  `);
  const base = Date.parse('2026-01-01T00:00:00Z');
  const groups = Array.from({ length: 80 }, (_, index) => {
    const group = index + 1;
    const account = group % 5 === 0 ? 2 : group % 3 === 0 ? 3 : 1;
    // Every group has multiple distinct candidates; the selected member is
    // determined by hash, and its priority can be later than the group's bound.
    const members = Array.from({ length: 3 }, (_, member) => ({ id: group * 10 + member,
      group, account, username: account === 1 ? 'alice' : account === 2 ? 'own-reviewer' : 'bob',
      paused: group % 7 === 0,
      priority: base + (group % 10) * 1000 + member * 100 }));
    const selected = [...members].sort((left, right) => createHash('sha256').update(`sampling-seed:${left.id}`).digest('hex')
      .localeCompare(createHash('sha256').update(`sampling-seed:${right.id}`).digest('hex')))[0];
    return { id: group, members, selected, earliest: members[0].priority };
  }).sort((left, right) => left.earliest - right.earliest || left.id - right.id);
  for (const group of groups) for (const member of group.members) {
    await pool.query('INSERT INTO tasks VALUES ($1,$2,$3,$1,$4,$5,$6)',
      [member.id, 'IMAGE_QC_PENDING', group.id, `run-${member.id}`, new Date(member.priority), member.paused]);
    await pool.query('INSERT INTO image_runs VALUES ($1,$2)', [`run-${member.id}`, member.id]);
    await pool.query('INSERT INTO image_approval_events VALUES ($1,$1,$1,$2,$3,$4,$5)',
      [member.id, `run-${member.id}`, new Date(Date.now() - 2 * 60 * 60_000), member.account, member.username]);
  }
  let freezeCalls = 0;
  const freeze = async row => {
    const group = groups.find(group => group.id === Number(row.production_batch_id));
    freezeCalls++;
    for (const member of group.members) await pool.query(`
      INSERT INTO image_sampling_items(task_id, approval_event_id, image_run_id,
        selected, status, submitter_account_id, submitter_username)
      VALUES ($1,$1,$2,$3,'PENDING',$4,$5)
    `, [member.id, `run-${member.id}`, member.id === group.selected.id, member.account, member.username]);
    return row;
  };
  const matches = (member, options) => (options.actor.role === 'ADMIN' || member.account !== options.actor.userId)
    && (!options.actionableOnly || !member.paused)
    && (!options.personName || member.username.includes(options.personName.toLowerCase())
      || ({ 1: 'alice smith', 2: 'own reviewer', 3: 'bob jones' })[member.account].includes(options.personName.toLowerCase()));
  async function selectedPage(options) {
    const rows = (await pool.query(`
      SELECT item.task_id, item.id, task.priority_sort_at, task.priority_paused,
        item.submitter_account_id, item.submitter_username
      FROM image_sampling_items item JOIN tasks task ON task.id=item.task_id
      WHERE item.selected ORDER BY task.priority_sort_at,item.id
    `)).rows;
    return rows.filter(row => matches({ account: Number(row.submitter_account_id), username: row.submitter_username,
      paused: row.priority_paused }, options)).slice(options.offset, options.offset + options.limit).map(row => Number(row.task_id));
  }

  const cases = [
    { name: 'more than twenty groups and a nonzero offset', actor: { role: 'ADMIN', userId: 4 }, limit: 20, offset: 25 },
    { name: 'ties must all be frozen before the page is stable', actor: { role: 'ADMIN', userId: 4 }, limit: 1, offset: 0 },
    { name: 'display-name filter narrows pending tails', actor: { role: 'ADMIN', userId: 4 }, personName: 'Smith', limit: 15, offset: 10 },
    { name: 'reviewer excludes self and paused actionable items', actor: { role: 'REVIEWER', userId: 2 }, actionableOnly: true, limit: 20, offset: 5 },
    { name: 'an incomplete last page drains every necessary scoped tail', actor: { role: 'REVIEWER', userId: 2 }, limit: 50, offset: 25 },
    { name: 'an expired sibling makes a newer high-priority selected member visible', actor: { role: 'ADMIN', userId: 4 }, limit: 1, offset: 0 },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    await pool.query('TRUNCATE image_sampling_items RESTART IDENTITY');
    if (entry.name.startsWith('an expired sibling')) {
      const group = groups.find(group => group.selected.id % 10 !== 0);
      group.selected.priority = base - 2000;
      group.earliest = base - 2000;
      await pool.query('UPDATE tasks SET priority_sort_at=$2 WHERE id=$1', [group.selected.id, new Date(group.selected.priority)]);
      await pool.query('UPDATE image_approval_events SET submitted_at=now() WHERE id=$1', [group.selected.id]);
      groups.sort((left, right) => left.earliest - right.earliest || left.id - right.id);
    }
    const options = { status: 'PENDING', personName: null, actionableOnly: false, ...entry };
    freezeCalls = 0;
    const drain = createImageQualityTailDrain({ pool, freeze,
      readSettings: async () => ({ imageSampling: { enabled: true, rateBps: 2000 } }) });
    const expected = groups.map(group => ({ ...group.selected, insertion: group.id }))
      .filter(member => matches(member, options))
      .sort((left, right) => left.priority - right.priority || left.insertion - right.insertion)
      .slice(options.offset, options.offset + options.limit).map(member => member.id);
    await drain.flushForPage(options);
    assert.deepEqual(await selectedPage(options), expected);
    const count = Number((await pool.query('SELECT count(*) FROM image_sampling_items WHERE selected')).rows[0].count);
    assert.equal(count, freezeCalls);
    if (entry.name.startsWith('more than twenty')) assert.ok(freezeCalls > 20);
    if (entry.name.startsWith('ties')) {
      assert.equal(freezeCalls, 8, 'all eight batches with the same earliest priority must be considered');
      assert.ok(freezeCalls < groups.length);
    }
    if (entry.personName) assert.ok(freezeCalls < groups.length);
    if (entry.actionableOnly) {
      const leaked = (await pool.query(`SELECT count(*) FROM image_sampling_items item JOIN tasks task ON task.id=item.task_id
        WHERE item.selected AND (item.submitter_account_id=2 OR task.priority_paused)`)).rows[0];
      assert.equal(Number(leaked.count), 0);
    }
    await drain.dispose();
  });
});
