import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  normalizeHumanQualitySettings,
  normalizeHumanQualitySettingsUpdate,
} from '../../src/human-quality-settings.mjs';
import { createControlPlaneApp } from '../src/http-server.mjs';
import { PostgresControlPlaneRepository } from '../src/postgres-repository.mjs';

const USERS = {
  admin: { id: 1, username: 'admin', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1 },
  reviewer: { id: 2, username: 'reviewer', role: 'REVIEWER', status: 'ACTIVE', credentialVersion: 1 },
  alice: { id: 3, username: 'alice', role: 'USER', status: 'ACTIVE', credentialVersion: 1 },
};

function actorHeaders(username) {
  return {
    'X-Actor-User-Id': String(USERS[username].id),
    'X-Actor-Username': username,
    'X-Actor-Role': USERS[username].role,
    'X-Actor-Credential-Version': '1',
  };
}

async function withServer(repository, action) {
  const storageRoot = await mkdtemp(resolve(tmpdir(), 'xhs-human-quality-settings-'));
  let server;
  try {
    const app = createControlPlaneApp({ repository, storageRoot, enforceUserAuth: true });
    await new Promise((ready, reject) => {
      server = app.listen(0, '127.0.0.1', ready);
      server.once('error', reject);
    });
    await action(`http://127.0.0.1:${server.address().port}`);
  } finally {
    if (server?.listening) await new Promise((closed) => server.close(closed));
    await rm(storageRoot, { recursive: true, force: true });
  }
}

test('all signed-in roles can read reason options while only administrators can replace them', async () => {
  let settings = normalizeHumanQualitySettings();
  let updates = 0;
  const repository = {
    getUserByUsername: async username => USERS[username] ?? null,
    getHumanQualitySettings: async () => settings,
    updateHumanQualitySettings: async input => {
      const normalized = normalizeHumanQualitySettings(input);
      updates++;
      settings = normalized;
      return settings;
    },
  };
  await withServer(repository, async root => {
    for (const username of Object.keys(USERS)) {
      const response = await fetch(`${root}/v1/human-quality-settings`, { headers: actorHeaders(username) });
      assert.equal(response.status, 200, username);
      assert.equal((await response.json()).data.copyReasons.length, 8);
    }
    assert.equal((await fetch(`${root}/v1/human-quality-settings`)).status, 401);

    const payload = { copyReasons: [{ code: '信息不完整', label: '信息不完整' }], imageReasons: [] };
    const expected = normalizeHumanQualitySettings(payload);
    const forbidden = await fetch(`${root}/v1/human-quality-settings`, {
      method: 'PUT', headers: { ...actorHeaders('reviewer'), 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(forbidden.status, 403);
    assert.equal(updates, 0);

    const saved = await fetch(`${root}/v1/human-quality-settings`, {
      method: 'PUT', headers: { ...actorHeaders('admin'), 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).data, expected);
    assert.equal(updates, 1);

    const invalid = await fetch(`${root}/v1/human-quality-settings`, {
      method: 'PUT', headers: { ...actorHeaders('admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ copyReasons: [{ code: '重复', label: '一' }, { code: '重复', label: '二' }], imageReasons: [] }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(updates, 1);
  });
});

test('repository replaces only human quality reasons inside the production record', async () => {
  const currentReasons = normalizeHumanQualitySettings();
  currentReasons.scoreDefinitions = currentReasons.scoreDefinitions.map((definition) => ({
    ...definition,
    title: `${definition.score} 分自定义`,
  }));
  currentReasons.noteGuidance = { copyPlaceholder: '自定义文案提示', imagePlaceholder: '自定义图片提示' };
  let production = {
    existingPolicy: 'preserved',
    modelApi: { agentProvider: 'CODEX' },
    humanQualityReasons: currentReasons,
  };
  const client = {
    async query(sql, values = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('INSERT INTO global_settings')) return { rows: [] };
      if (sql.includes("SELECT value FROM global_settings WHERE key = 'production' FOR UPDATE")) {
        return { rows: [{ value: production }] };
      }
      if (sql.includes('UPDATE global_settings SET')) {
        production = { ...production, humanQualityReasons: JSON.parse(values[0]) };
        return { rows: [{ value: production }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const repository = new PostgresControlPlaneRepository({ pool: { connect: async () => client } });
  const input = { copyReasons: [{ code: '结构松散', label: '结构松散' }], imageReasons: [] };
  assert.deepEqual(
    await repository.updateHumanQualitySettings(input),
    normalizeHumanQualitySettingsUpdate(input, currentReasons),
  );
  assert.equal(production.existingPolicy, 'preserved');
  assert.equal(production.modelApi.agentProvider, 'CODEX');
});

test('generic production upsert preserves independently managed reasons even when submitted', async () => {
  const reasons = { copyReasons: [{ code: '内容太泛', label: '内容太泛' }], imageReasons: [] };
  const pool = {
    async query(sql) {
      assert.match(sql, /global_settings\.value \? 'humanQualityReasons'/u);
      assert.doesNotMatch(sql, /NOT excluded\.value \? 'humanQualityReasons'/u);
      return { rows: [{
        key: 'production',
        value: { knowledgeEnabled: false, humanQualityReasons: reasons },
        version: 2,
        updated_at: new Date('2026-09-08T00:00:00.000Z'),
      }] };
    },
  };
  const repository = new PostgresControlPlaneRepository({ pool });
  const result = await repository.upsertSetting('production', {
    knowledgeEnabled: false,
    humanQualityReasons: { copyReasons: [{ code: 'STALE', label: '旧页面原因' }], imageReasons: [] },
  });
  assert.deepEqual(result.value.humanQualityReasons, reasons);
});
