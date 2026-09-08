import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import { createControlPlaneApp } from '../src/http-server.mjs';
import { assetConditionalHeaders } from '../../src/control-plane/asset-proxy.mjs';

function actorHeaders(username = 'alice', extra = {}) {
  return {
    'X-Actor-User-Id': String(username === 'alice' ? 2 : username === 'bob' ? 3 : ''),
    'X-Actor-Username': username,
    'X-Actor-Role': 'USER',
    'X-Actor-Credential-Version': '1',
    ...extra,
  };
}

function validationHeaders(etag, username = 'alice') {
  return actorHeaders(username, { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' });
}

async function withServer(fixture, action) {
  const app = createControlPlaneApp({
    repository: fixture.repository,
    storageRoot: fixture.storageRoot,
    enforceUserAuth: true,
  });
  const server = await new Promise((resolve, reject) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
    value.once('error', reject);
  });
  try {
    return await action(`http://127.0.0.1:${server.address().port}/v1/assets/7`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function assetFixture(t, { width = 1200, height = 800, lightweightOnly = false } = {}) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-asset-delivery-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const directory = join(storageRoot, 'tasks', '12', 'image-runs', 'run-1');
  await mkdir(directory, { recursive: true });
  const storagePath = join(directory, 'original.png');
  const original = await sharp({
    create: { width, height, channels: 4, background: { r: 40, g: 90, b: 160, alpha: 0.4 } },
  }).png().toBuffer();
  await writeFile(storagePath, original);
  const asset = {
    id: 7, taskId: 12, imageRunId: 'run-1', storagePath,
    mediaType: 'image/png', originalName: '01-cover.png', byteSize: original.length,
    sha256: createHash('sha256').update(original).digest('hex'),
  };
  const task = {
    id: 12,
    createdByUserId: 'alice',
    createdByAccountId: 2,
    assignedToUserId: 'alice',
    assignedToAccountId: 2,
  };
  const users = {
    alice: { id: 2, username: 'alice', role: 'USER', status: 'ACTIVE', credentialVersion: 1 },
    bob: { id: 3, username: 'bob', role: 'USER', status: 'ACTIVE', credentialVersion: 1 },
  };
  const repository = {
    getAsset: async (id) => Number(id) === asset.id ? asset : null,
    getUserByUsername: async (username) => users[username] ?? null,
    getTaskAccess: async (id) => Number(id) === task.id ? task : null,
    getTask: async (id) => {
      if (lightweightOnly) throw new Error('asset delivery must not load complete task history');
      return Number(id) === task.id ? task : null;
    },
  };
  return { storageRoot, storagePath, original, users, repository };
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

test('asset reads preserve original bytes and require private cache revalidation', async (t) => {
  const fixture = await assetFixture(t);
  await withServer(fixture, async (url) => {
    const response = await fetch(url, { headers: actorHeaders() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture.original);
    assert.equal(response.headers.get('cache-control'), 'private, no-cache');
    assert.ok(response.headers.get('etag'), 'original image must have a validator');
  });
});

test('a stale postflight response cannot retain asset validators or cache metadata', async (t) => {
  const fixture = await assetFixture(t);
  fixture.repository.getUserByIdentity = async () => null;
  await withServer(fixture, async (url) => {
    const response = await fetch(url, { headers: actorHeaders() });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('etag'), null);
    assert.equal(response.headers.get('content-range'), null);
    assert.equal(response.headers.get('accept-ranges'), null);
    assert.equal((await response.json()).error.code, 'SESSION_STALE');
  });
});

test('thumbnail reads return bounded WebP images with original proportions and alpha', async (t) => {
  const fixture = await assetFixture(t);
  await withServer(fixture, async (url) => {
    const response = await fetch(`${url}?variant=thumbnail`, { headers: actorHeaders() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    const thumbnail = Buffer.from(await response.arrayBuffer());
    const metadata = await sharp(thumbnail).metadata();
    assert.equal(metadata.format, 'webp');
    assert.ok(metadata.width > 0 && metadata.height > 0);
    assert.ok(Math.max(metadata.width, metadata.height) <= 480);
    assert.ok(Math.abs(metadata.height - metadata.width * 800 / 1200) <= 1, 'thumbnail must retain the source aspect ratio');
    assert.equal(metadata.hasAlpha, true);
    const { data, info } = await sharp(thumbnail).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 4);
    assert.ok(Math.abs(data[3] - 102) <= 1, 'semi-transparent pixels must not be flattened');
    assert.equal(response.headers.get('cache-control'), 'private, no-cache');
    assert.ok(response.headers.get('etag'));
  });
});

test('thumbnail generation does not enlarge a small source image', async (t) => {
  const fixture = await assetFixture(t, { width: 80, height: 120 });
  await withServer(fixture, async (url) => {
    const response = await fetch(`${url}?variant=thumbnail`, { headers: actorHeaders() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    assert.equal(metadata.width, 80);
    assert.equal(metadata.height, 120);
  });
});

test('unknown asset variants are rejected instead of silently serving originals', async (t) => {
  const fixture = await assetFixture(t);
  await withServer(fixture, async (url) => {
    const response = await fetch(`${url}?variant=giant`, { headers: actorHeaders() });
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  });
});

test('original and thumbnail validators are distinct and matching validators return empty 304 responses', async (t) => {
  const fixture = await assetFixture(t);
  await withServer(fixture, async (url) => {
    const etags = [];
    for (const suffix of ['', '?variant=thumbnail']) {
      const first = await fetch(`${url}${suffix}`, { headers: actorHeaders() });
      assert.equal(first.status, 200);
      await first.arrayBuffer();
      const etag = first.headers.get('etag');
      assert.ok(etag, 'every representation must have a validator');
      etags.push(etag);
      const cached = await fetch(`${url}${suffix}`, { headers: validationHeaders(etag) });
      assert.equal(cached.status, 304);
      assert.equal(cached.headers.get('etag'), etag);
      assert.equal(cached.headers.get('cache-control'), 'private, no-cache');
      assert.equal((await cached.arrayBuffer()).byteLength, 0);
    }
    assert.notEqual(etags[0], etags[1]);
    const differentRepresentation = await fetch(`${url}?variant=thumbnail`, { headers: validationHeaders(etags[0]) });
    assert.equal(differentRepresentation.status, 200, 'an original-image validator cannot validate a thumbnail');
    await differentRepresentation.arrayBuffer();
  });
});

test('matching image validators cannot bypass task ownership or invalidated accounts', async (t) => {
  const fixture = await assetFixture(t);
  await withServer(fixture, async (url) => {
    for (const suffix of ['', '?variant=thumbnail']) {
      const first = await fetch(`${url}${suffix}`, { headers: actorHeaders() });
      assert.equal(first.status, 200);
      await first.arrayBuffer();
      const etag = first.headers.get('etag');
      assert.ok(etag);
      const forbidden = await fetch(`${url}${suffix}`, { headers: validationHeaders(etag, 'bob') });
      assert.equal(forbidden.status, 403);
      assert.equal((await forbidden.json()).error.code, 'FORBIDDEN');
      fixture.users.alice.status = 'DISABLED';
      const disabled = await fetch(`${url}${suffix}`, { headers: validationHeaders(etag) });
      assert.equal(disabled.status, 401);
      assert.equal((await disabled.json()).error.code, 'SESSION_STALE');
      fixture.users.alice.status = 'ACTIVE';
      fixture.users.alice.credentialVersion = 2;
      const stale = await fetch(`${url}${suffix}`, { headers: validationHeaders(etag) });
      assert.equal(stale.status, 401);
      assert.equal((await stale.json()).error.code, 'SESSION_STALE');
      fixture.users.alice.credentialVersion = 1;
    }
  });
});

test('asset validators survive the Next proxy no-store fetch mode', async (t) => {
  const fixture = await assetFixture(t);
  await withServer(fixture, async (url) => {
    for (const suffix of ['', '?variant=thumbnail']) {
      const first = await fetch(`${url}${suffix}`, { headers: actorHeaders(), cache: 'no-store' });
      assert.equal(first.status, 200);
      await first.arrayBuffer();
      const etag = first.headers.get('etag');
      assert.ok(etag);
      const browserRequest = new Request(`${url}${suffix}`, { headers: { 'If-None-Match': etag } });
      const validated = await fetch(`${url}${suffix}`, {
        headers: { ...actorHeaders(), ...assetConditionalHeaders('/v1/assets/7', browserRequest) },
        cache: 'no-store',
      });
      assert.equal(validated.status, 304, 'upstream fetch must preserve conditional browser requests');
      assert.equal((await validated.arrayBuffer()).byteLength, 0);
    }
  });
});

test('asset authorization works without loading full task history', async (t) => {
  const fixture = await assetFixture(t, { lightweightOnly: true });
  await withServer(fixture, async (url) => {
    for (const suffix of ['', '?variant=thumbnail']) {
      const response = await fetch(`${url}${suffix}`, { headers: actorHeaders() });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      const forbidden = await fetch(`${url}${suffix}`, { headers: actorHeaders('bob') });
      assert.equal(forbidden.status, 403);
      await forbidden.json();
    }
  });
});

test('thumbnail reads reuse a generated disk artifact across app instances', async (t) => {
  const fixture = await assetFixture(t);
  const firstBytes = await withServer(fixture, async (url) => {
    const response = await fetch(`${url}?variant=thumbnail`, { headers: actorHeaders() });
    assert.equal(response.status, 200);
    return Buffer.from(await response.arrayBuffer());
  });
  const generatedFiles = (await filesUnder(fixture.storageRoot)).filter((path) => path !== fixture.storagePath);
  let thumbnailPath;
  for (const path of generatedFiles) {
    if ((await readFile(path)).equals(firstBytes)) thumbnailPath = path;
  }
  assert.ok(thumbnailPath, 'first thumbnail request must persist the generated image');
  const olderTime = new Date(Date.now() - 60_000);
  await utimes(thumbnailPath, olderTime, olderTime);
  const before = await stat(thumbnailPath);
  await withServer(fixture, async (url) => {
    const response = await fetch(`${url}?variant=thumbnail`, { headers: actorHeaders() });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), firstBytes);
  });
  assert.equal((await stat(thumbnailPath)).mtimeMs, before.mtimeMs, 'cache hit must not regenerate the image');
  assert.deepEqual((await filesUnder(fixture.storageRoot)).sort(), [fixture.storagePath, ...generatedFiles].sort());
});
