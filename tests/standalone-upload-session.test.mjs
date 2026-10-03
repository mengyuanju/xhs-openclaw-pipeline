import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const uploadSource = readFile(new URL('../app/image-editor/upload-images.ts', import.meta.url), 'utf8');
const file = { type: 'image/png', base64: 'dGVzdA==' };
const workspace = { id: 123, ownerId: 1 };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class FakeApiRequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

class FakeFileReader {
  readAsDataURL(value) {
    this.result = `data:${value.type};base64,${value.base64}`;
    queueMicrotask(() => this.onload());
  }
}

async function browserHarness(request) {
  let generation = 0;
  const calls = [];
  const progress = [];
  // Execute the real frontend helper with only browser/network dependencies
  // replaced. Native type stripping avoids a build or a second implementation.
  const source = (await uploadSource).replace(/^import .*$/gmu, '')
    .replace('export async function', 'async function');
  const context = {
    AbortController, TypeError, FileReader: FakeFileReader,
    ApiRequestError: FakeApiRequestError,
    browserSessionGeneration: () => generation,
    apiRequest: (url, options) => {
      calls.push({ url, options });
      return request(url, options);
    },
  };
  runInNewContext(`${stripTypeScriptTypes(source)}\nthis.upload = uploadEditorImages;`, context);
  return {
    calls, progress,
    changeAccount: () => { generation += 1; },
    upload: () => context.upload([file], {
      requestId: randomUUID(), title: 'Session boundary regression',
      onProgress: (completed, total) => progress.push([completed, total]),
    }),
  };
}

function stageResponse(url) {
  if (url.endsWith('/limits')) return { binaryUploadVersion: 1 };
  if (/\/uploads\/[^/]+\/1$/u.test(url)) return { index: 1, token: randomUUID() };
  throw new Error(`Unexpected fake request: ${url}`);
}

test('binary upload rejects an old-account success received during commit', async () => {
  const entered = deferred(), completed = deferred();
  const browser = await browserHarness(async url => {
    if (!url.endsWith('/workspaces')) return stageResponse(url);
    entered.resolve(); return completed.promise;
  });
  const pending = browser.upload();
  const rejected = assert.rejects(pending, /账号已变化/u);
  await entered.promise;
  browser.changeAccount(); completed.resolve(workspace);
  await rejected;
  assert.equal(browser.calls.filter(call => call.url.endsWith('/workspaces')).length, 1);
  assert.equal(browser.calls.filter(call => call.options?.method === 'DELETE').length, 0,
    'must not cancel the old upload using a newly signed-in account');
});

test('lost-response retry also rejects a success received after an account change', async () => {
  const entered = deferred(), completed = deferred();
  const bodies = [];
  const browser = await browserHarness(async (url, options) => {
    if (!url.endsWith('/workspaces')) return stageResponse(url);
    bodies.push(options.body);
    if (bodies.length === 1) throw new FakeApiRequestError(503, 'Committed response was lost');
    entered.resolve(); return completed.promise;
  });
  const pending = browser.upload();
  const rejected = assert.rejects(pending, /账号已变化/u);
  await entered.promise;
  browser.changeAccount(); completed.resolve(workspace);
  await rejected;
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1], 'retry must preserve the request ID and complete upload manifest');
  assert.equal(browser.calls.filter(call => call.options?.method === 'DELETE').length, 0);
});

test('legacy upload rejects an old-account success received during commit', async () => {
  const entered = deferred(), completed = deferred();
  const browser = await browserHarness(async url => {
    if (url.endsWith('/limits')) return {};
    assert.ok(url.endsWith('/workspaces'));
    entered.resolve(); return completed.promise;
  });
  const pending = browser.upload();
  const rejected = assert.rejects(pending, /账号已变化/u);
  await entered.promise;
  browser.changeAccount(); completed.resolve(workspace);
  await rejected;
  const sent = browser.calls.find(call => call.url.endsWith('/workspaces'));
  assert.equal(JSON.parse(sent.options.body).images[0].base64, file.base64);
});

test('a stage completed after an account change cannot report progress or start a commit', async () => {
  const entered = deferred(), completed = deferred();
  const browser = await browserHarness(async url => {
    if (url.endsWith('/limits')) return { binaryUploadVersion: 1 };
    assert.match(url, /\/uploads\/[^/]+\/1$/u);
    entered.resolve(); return completed.promise;
  });
  const pending = browser.upload();
  const rejected = assert.rejects(pending, /账号已变化/u);
  await entered.promise;
  browser.changeAccount(); completed.resolve({ index: 1, token: randomUUID() });
  await rejected;
  assert.deepEqual(browser.progress, []);
  assert.equal(browser.calls.filter(call => call.url.endsWith('/workspaces')).length, 0);
  assert.equal(browser.calls.filter(call => call.options?.method === 'DELETE').length, 0);
  assert.equal(browser.calls.find(call => call.options?.signal)?.options.signal.aborted, true);
});
