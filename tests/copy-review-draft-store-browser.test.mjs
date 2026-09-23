import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('local copy review drafts use IndexedDB transactions, scoped history and one-time migration', {
  skip: process.env.RUN_COPY_REVIEW_DRAFT_STORE_BROWSER !== '1', timeout: 60_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const directory = await mkdtemp(join(tmpdir(), 'copy-review-draft-store-'));
  let browser;
  let server;
  try {
    await build({
      entryPoints: [resolve('app/workbench/copy-review-draft-store.ts')],
      bundle: true, format: 'esm', platform: 'browser',
      outfile: join(directory, 'store.js'),
    });
    const bundle = await readFile(join(directory, 'store.js'));
    server = createServer((request, response) => {
      if (request.url === '/store.js') {
        response.setHeader('content-type', 'application/javascript');
        response.end(bundle);
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><meta charset="utf-8"><title>IndexedDB draft test</title>');
    });
    await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
    browser = await chromium.launch({ headless: true, channel: process.env.IMAGE_EDIT_BROWSER_CHANNEL ?? 'msedge' });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const outcome = await page.evaluate(async () => {
      const store = await import('/store.js');
      const scope = { accountId: 17, taskId: 42, baseCopyRevisionId: 9, reviewerUsername: 'reviewer' };
      const otherAccount = { ...scope, accountId: 18 };
      const otherRevision = { ...scope, baseCopyRevisionId: 10 };
      const first = await store.saveLocalCopyReviewDraft(scope, {
        expectedLatestDraftId: null, content: { version: 1, title: '草稿一' },
      });
      const savedScopeSkipsMigration = !await store.needsLegacyCopyReviewDraftImport(scope);
      const replay = await store.saveLocalCopyReviewDraft(scope, {
        expectedLatestDraftId: null, content: { title: '草稿一', version: 1 },
      });
      const competing = await Promise.allSettled([
        store.saveLocalCopyReviewDraft(scope, {
          expectedLatestDraftId: first.draft.id, content: { version: 1, title: '第二窗口' },
        }),
        store.saveLocalCopyReviewDraft(scope, {
          expectedLatestDraftId: first.draft.id, content: { version: 1, title: '第三窗口' },
        }),
      ]);
      const afterRace = await store.listLocalCopyReviewDrafts(scope);
      const isolated = [await store.listLocalCopyReviewDrafts(otherAccount),
        await store.listLocalCopyReviewDrafts(otherRevision)];
      let previousId = null;
      for (let version = 1; version <= 22; version += 1) {
        const saved = await store.saveLocalCopyReviewDraft(otherRevision, {
          expectedLatestDraftId: previousId,
          content: { version: 1, title: `草稿${version}` },
        });
        previousId = saved.draft.id;
      }
      const retainedVersions = (await store.listLocalCopyReviewDrafts(otherRevision)).drafts.map(draft => draft.version);

      const legacyScope = { accountId: 17, taskId: 43, baseCopyRevisionId: 11, reviewerUsername: 'reviewer' };
      const now = Date.now();
      const legacy = Array.from({ length: 24 }, (_, index) => ({
        id: index + 1, taskId: 43, baseCopyRevisionId: 11, reviewerAccountId: 17,
        version: index + 1, content: { version: 1, title: `旧草稿${index + 1}` },
        createdAt: new Date(now - (24 - index) * 1000).toISOString(),
      }));
      legacy.push({ ...legacy[0], id: 100, version: 25, createdAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString() });
      const neededBefore = await store.needsLegacyCopyReviewDraftImport(legacyScope);
      await store.importLegacyCopyReviewDrafts(legacyScope, legacy);
      await store.importLegacyCopyReviewDrafts(legacyScope, legacy);
      const imported = await store.listLocalCopyReviewDrafts(legacyScope);
      const neededAfter = await store.needsLegacyCopyReviewDraftImport(legacyScope);
      await store.clearLocalCopyReviewDrafts(legacyScope);
      const afterClear = await store.listLocalCopyReviewDrafts(legacyScope);
      const neededAfterClear = await store.needsLegacyCopyReviewDraftImport(legacyScope);

      // Simulate an old browser record without waiting seven days.
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('xhs-copy-review-drafts-v1');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('drafts', 'readwrite');
        const drafts = transaction.objectStore('drafts');
        const request = drafts.get(afterRace.drafts[0].id);
        request.onsuccess = () => {
          const row = request.result;
          row.createdAtMs = now - 8 * 24 * 60 * 60 * 1000;
          drafts.put(row);
        };
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      const afterExpiry = await store.listLocalCopyReviewDrafts(scope);
      Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
      const unavailable = await store.listLocalCopyReviewDrafts(scope).then(
        () => false,
        error => error instanceof store.LocalCopyReviewDraftStorageError,
      );
      return {
        first, replay, savedScopeSkipsMigration, unavailable,
        race: competing.map(result => result.status === 'fulfilled'
          ? { status: 'fulfilled', version: result.value.draft.version }
          : { status: 'rejected', conflict: result.reason instanceof store.LocalCopyReviewDraftConflictError }),
        afterRace, isolated, retainedVersions, neededBefore, neededAfter, imported, afterClear, neededAfterClear, afterExpiry,
      };
    });
    assert.match(outcome.first.draft.id, /^local:/);
    assert.equal(outcome.replay.created, false);
    assert.equal(outcome.replay.draft.id, outcome.first.draft.id);
    assert.equal(outcome.savedScopeSkipsMigration, true);
    assert.equal(outcome.unavailable, true);
    assert.equal(outcome.race.filter(item => item.status === 'fulfilled').length, 1);
    assert.deepEqual(outcome.race.filter(item => item.status === 'rejected'), [{ status: 'rejected', conflict: true }]);
    assert.deepEqual(outcome.afterRace.drafts.map(draft => draft.version), [2, 1]);
    assert.deepEqual(outcome.isolated.map(result => result.drafts.length), [0, 0]);
    assert.deepEqual(outcome.retainedVersions, Array.from({ length: 20 }, (_, index) => 22 - index));
    assert.equal(outcome.neededBefore, true);
    assert.equal(outcome.neededAfter, false);
    assert.equal(outcome.imported.drafts.length, 20);
    assert.deepEqual([outcome.imported.drafts[0].version, outcome.imported.drafts.at(-1).version], [25, 6]);
    assert.ok(Date.now() - Date.parse(outcome.imported.drafts[0].createdAt) > 7 * 24 * 60 * 60 * 1000);
    assert.ok(outcome.imported.drafts.every(draft => draft.id.startsWith('local:')));
    assert.equal(outcome.afterClear.drafts.length, 0);
    assert.equal(outcome.neededAfterClear, false);
    assert.deepEqual(outcome.afterExpiry.drafts.map(draft => draft.version), [1]);
  } finally {
    await browser?.close();
    if (server) await new Promise(resolveClosing => server.close(resolveClosing));
    assert.ok(directory.startsWith(join(tmpdir(), 'copy-review-draft-store-')));
    await rm(directory, { recursive: true, force: true });
  }
});
