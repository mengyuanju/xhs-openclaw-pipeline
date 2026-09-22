import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createRequestId } from '../app/components/request-id.ts';
import { createRequestId as createPreviewRequestId } from '../preview-service/lib/request-id.ts';

test('request IDs prefer the browser native random UUID implementation', () => {
  const expected = '11111111-2222-4333-8444-555555555555';
  let fallbackCalled = false;
  const requestId = createRequestId({
    randomUUID: () => expected,
    getRandomValues: (bytes) => {
      fallbackCalled = true;
      return bytes;
    },
  });

  assert.equal(requestId, expected);
  assert.equal(fallbackCalled, false);
});

test('request IDs remain valid when randomUUID is unavailable outside a secure context', () => {
  const requestId = createRequestId({
    getRandomValues: (bytes) => {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    },
  });

  assert.equal(requestId, '00010203-0405-4607-8809-0a0b0c0d0e0f');
  assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});

test('preview request IDs remain valid when randomUUID is unavailable outside a secure context', () => {
  const requestId = createPreviewRequestId({
    getRandomValues: (bytes) => {
      bytes.fill(0xab);
      return bytes;
    },
  });

  assert.equal(requestId, 'abababab-abab-4bab-abab-abababababab');
});

test('copy QA mutations use request IDs that work without crypto.randomUUID', async () => {
  const source = await readFile(new URL('../app/copy-qa/copy-qa-workbench.tsx', import.meta.url), 'utf8');

  assert.match(source, /import \{ createRequestId \} from '\.\.\/components\/request-id';/u);
  assert.equal(source.match(/createRequestId\(\)/gu)?.length, 4);
  assert.doesNotMatch(source, /crypto\.randomUUID/u);
});

test('all browser UUID call sites use the insecure-context-compatible helper', async () => {
  const urls = [
    '../app/delivery-pool/shared-delivery-workbench.tsx',
    '../app/copy-flow/page.tsx',
    '../app/settings/layout-presets-settings.tsx',
    '../preview-service/components/preview-manager.tsx',
    '../preview-service/components/batch-preview-creator.tsx',
  ];

  for (const url of urls) {
    const source = await readFile(new URL(url, import.meta.url), 'utf8');
    assert.match(source, /createRequestId/u, `${url} must use the compatible UUID helper`);
    assert.doesNotMatch(source, /crypto\.randomUUID/u, `${url} must work over LAN HTTP`);
  }
});

test('delivery archive retries reuse the request ID for the same selection', async () => {
  const source = await readFile(new URL('../app/delivery-pool/shared-delivery-workbench.tsx', import.meta.url), 'utf8');

  assert.match(source, /archiveMutation = useRef<\{ fingerprint: string; requestId: string \} \| null>/u);
  assert.match(source, /archiveMutation\.current\?\.fingerprint !== fingerprint/u);
  assert.match(source, /requestId: mutation\.requestId/u);
  assert.match(source, /archiveMutation\.current === mutation\) archiveMutation\.current = null/u);
});
