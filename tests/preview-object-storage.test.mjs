import assert from 'node:assert/strict';
import test from 'node:test';

import { createR2ObjectStorage } from '../preview-service/lib/server/object-storage.ts';

test('R2 adapter exposes the provider-neutral object storage contract', async () => {
  const calls = [];
  const storedBody = new ReadableStream();
  const bucket = {
    put: async (...args) => { calls.push(['put', ...args]); },
    get: async (...args) => {
      calls.push(['get', ...args]);
      return args[0] === 'missing' ? null : { body: storedBody };
    },
    delete: async (...args) => { calls.push(['delete', ...args]); },
  };
  const storage = createR2ObjectStorage(bucket);
  const bytes = new Uint8Array([1, 2, 3]).buffer;

  await storage.putObject('previews/1/original.png', bytes, {
    contentType: 'image/png',
    sha256: 'a'.repeat(64),
  });
  assert.deepEqual(calls[0], [
    'put',
    'previews/1/original.png',
    bytes,
    {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { sha256: 'a'.repeat(64) },
    },
  ]);
  assert.equal(
    (await storage.getObject('previews/1/original.png')).body,
    storedBody,
  );
  assert.equal(await storage.getObject('missing'), null);
  await storage.deleteObjects(['previews/1/original.png']);
  assert.deepEqual(calls.at(-1), [
    'delete',
    ['previews/1/original.png'],
  ]);
});
