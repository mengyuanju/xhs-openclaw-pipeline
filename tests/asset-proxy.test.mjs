import assert from 'node:assert/strict';
import test from 'node:test';
import { assetConditionalHeaders, assetResponseHeaders, thumbnailUrl } from '../src/control-plane/asset-proxy.mjs';

test('only asset reads forward conditional validators', () => {
  const request = new Request('http://localhost/api/control-plane/v1/assets/7', { headers: { 'If-None-Match': '"image"' } });
  assert.deepEqual(assetConditionalHeaders('/v1/assets/7', request), { 'If-None-Match': '"image"', 'Cache-Control': 'max-age=0' });
  assert.deepEqual(assetConditionalHeaders('/v1/tasks/7', request), {});
  assert.deepEqual(assetConditionalHeaders('/v1/assets/7', new Request(request.url, { method: 'POST', headers: request.headers })), {});
});

test('private asset validators survive the proxy but errors and other resources are never cached', () => {
  for (const status of [200, 304]) {
    const response = new Response(null, { status, headers: { 'Cache-Control': 'private, no-cache', ETag: '"image"' } });
    assert.deepEqual(assetResponseHeaders('/v1/assets/7', response), { 'Cache-Control': 'private, no-cache', ETag: '"image"', Vary: 'Cookie' });
    assert.deepEqual(assetResponseHeaders('/v1/tasks/7', response), { 'Cache-Control': 'no-store' });
  }
  for (const status of [401, 403, 404, 500]) {
    assert.deepEqual(assetResponseHeaders('/v1/assets/7', new Response(null, { status,
      headers: { 'Cache-Control': 'private, no-cache', ETag: '"image"' } })), { 'Cache-Control': 'no-store' });
  }
  assert.deepEqual(assetResponseHeaders('/v1/assets/7', new Response(null)), { 'Cache-Control': 'no-store' });
});

test('thumbnail URLs only rewrite task assets, leaving local images and external sources unchanged', () => {
  assert.equal(thumbnailUrl('/api/control-plane/v1/assets/12'), '/api/control-plane/v1/assets/12?variant=thumbnail');
  for (const src of ['/api/assets/12', 'blob:test', 'https://example.com/image.png', '/api/control-plane/v1/assets/12?variant=thumbnail']) {
    assert.equal(thumbnailUrl(src), src);
  }
});
