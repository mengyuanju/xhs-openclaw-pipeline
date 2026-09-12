import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  addDeliveryPreviewUrls,
  createDeliveryPreviewUrlResolver,
  createPreviewServiceClient,
  groupPreviewItems,
  normalizeDeliveryPreviewRequest,
  publishDeliveryPreviews,
} from '../src/delivery-preview.mjs';

const admin = Object.freeze({ role: 'ADMIN', userId: 1, username: 'admin' });
const imageRunId = '11111111-1111-4111-8111-111111111111';
const previewId = '22222222-2222-4222-8222-222222222222';
const noteId = '0123456789abcdef0123456789abcdef';
const contentHash = 'a'.repeat(64);

function groupItem(taskId, imageCount = 1, byteSize = 1) {
  return {
    taskId,
    imageCount,
    byteSize,
    assets: Array.from({ length: imageCount }, () => ({})),
  };
}

test('administrator preview request requires explicit package ids and splits remote calls at 10 items', () => {
  const queryPackageIds = Array.from({ length: 200 }, (_, index) => index + 1);
  assert.deepEqual(normalizeDeliveryPreviewRequest({
    scope: 'QUERY_PACKAGES',
    queryPackageIds,
    limit: 200,
  }), {
    scope: 'QUERY_PACKAGES', queryPackageIds, includeUnassigned: false,
    taskIds: [], testTaskId: null, limit: 200,
  });
  assert.deepEqual(normalizeDeliveryPreviewRequest({
    scope: 'QUERY_PACKAGES',
    queryPackageIds: [],
    includeUnassigned: true,
    limit: 50,
  }), {
    scope: 'QUERY_PACKAGES', queryPackageIds: [], includeUnassigned: true,
    taskIds: [], testTaskId: null, limit: 50,
  });
  assert.deepEqual(normalizeDeliveryPreviewRequest({
    scope: 'QUERY_PACKAGES',
    queryPackageIds: [],
    includeUnassigned: true,
    testTaskId: 588,
    limit: 1,
  }), {
    scope: 'QUERY_PACKAGES', queryPackageIds: [], includeUnassigned: true,
    taskIds: [], testTaskId: 588, limit: 1,
  });
  assert.deepEqual(normalizeDeliveryPreviewRequest({
    scope: 'QUERY_PACKAGES',
    queryPackageIds: [9],
    taskIds: [588, 589],
    limit: 2,
  }), {
    scope: 'QUERY_PACKAGES', queryPackageIds: [9], includeUnassigned: false,
    taskIds: [588, 589], testTaskId: null, limit: 2,
  });
  assert.throws(() => normalizeDeliveryPreviewRequest({
    scope: 'SELECTED',
    taskIds: [1, 2, 3],
    limit: 3,
  }), /explicitly selected delivery sources/u);
  assert.throws(() => normalizeDeliveryPreviewRequest({
    scope: 'QUERY_PACKAGES',
    queryPackageIds: [1],
    limit: 201,
  }), /1 to 200/u);
  assert.throws(() => normalizeDeliveryPreviewRequest({
    scope: 'QUERY_PACKAGES',
    queryPackageIds: ['1'],
    limit: 10,
  }), /positive integers/u);
  assert.throws(() => normalizeDeliveryPreviewRequest({
    scope: 'QUERY_PACKAGES',
    queryPackageIds: [],
    includeUnassigned: false,
    limit: 10,
  }), /explicitly select/u);
  assert.throws(() => normalizeDeliveryPreviewRequest({
    scope: 'QUERY_PACKAGES',
    queryPackageIds: [9],
    testTaskId: 588,
    limit: 10,
  }), /requires limit 1/u);
  assert.throws(() => normalizeDeliveryPreviewRequest({
    scope: 'QUERY_PACKAGES',
    queryPackageIds: [9],
    taskIds: [588, 588],
    limit: 2,
  }), /unique positive integers/u);
  assert.throws(() => normalizeDeliveryPreviewRequest({
    scope: 'QUERY_PACKAGES',
    queryPackageIds: [9],
    taskIds: [588, 589],
    limit: 1,
  }), /must match taskIds count/u);
  assert.throws(() => normalizeDeliveryPreviewRequest({
    scope: 'QUERY_PACKAGES',
    queryPackageIds: [9],
    taskIds: [588],
    testTaskId: 588,
    limit: 1,
  }), /cannot be used together/u);

  const groups = groupPreviewItems(
    Array.from({ length: 21 }, (_, index) => groupItem(index + 1)),
  );
  assert.deepEqual(groups.map((group) => group.length), [10, 10, 1]);
  assert.deepEqual(
    groupPreviewItems([groupItem(1, 40, 30 * 1024 * 1024), groupItem(2, 30, 31 * 1024 * 1024)])
      .map((group) => group.length),
    [1, 1],
  );
});

test('delivery preview URLs are derived from the current configured origin', () => {
  const resolvePreviewUrl = createDeliveryPreviewUrlResolver(
    'https://new-preview.example.com/admin',
  );
  assert.equal(
    resolvePreviewUrl(noteId),
    `https://new-preview.example.com/preview?noteId=${noteId}`,
  );
  const page = addDeliveryPreviewUrls({
    items: [{
      id: 77,
      preview: { id: previewId, noteId, status: 'PUBLISHED' },
    }],
    total: 1,
  }, resolvePreviewUrl);
  assert.equal(
    page.items[0].preview.url,
    `https://new-preview.example.com/preview?noteId=${noteId}`,
  );
  assert.equal(
    addDeliveryPreviewUrls(page, null).items[0].preview.url,
    null,
  );
});

test('preview client sends server-side credentials, sourceRef and original bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xhs-preview-client-'));
  try {
    const path = join(directory, '01.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const assetSha = createHash('sha256').update(bytes).digest('hex');
    const expectedHash = createHash('sha256').update(JSON.stringify({
      title: '标题',
      body: '正文',
      tags: ['收纳', '生活'],
      images: [assetSha],
    })).digest('hex');
    await writeFile(path, bytes);
    let calls = 0;
    const client = createPreviewServiceClient({
      baseUrl: 'https://preview.example.com/admin',
      apiKey: 'server-secret',
      fetchImpl: async (url, options) => {
        calls += 1;
        assert.equal(String(url), 'https://preview.example.com/api/v1/previews/batch');
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.Authorization, 'Bearer server-secret');
        const manifest = JSON.parse(options.body.get('manifest'));
        assert.deepEqual(manifest, {
          items: [{
            clientId: 'delivery_77',
            sourceRef: 'xhs:delivery:77',
            title: '标题',
            body: '正文',
            tags: '收纳,生活',
          }],
        });
        const uploaded = options.body.get('images.delivery_77');
        assert.equal(uploaded.name, '01.png');
        assert.equal(uploaded.type, 'image/png');
        assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), bytes);
        return Response.json({
          items: [{
            clientId: 'delivery_77',
            preview: {
              id: previewId,
              publicId: noteId,
              contentHash: expectedHash,
              status: 'PUBLISHED',
              publishedAt: 1_789_000_000_000,
            },
            previewUrl: `https://preview.example.com/?noteId=${noteId}`,
            reused: false,
          }],
        }, { status: 201 });
      },
    });
    const source = {
      taskId: 7,
      binding: { deliveryEntryId: 77 },
      clientId: 'delivery_77',
      sourceRef: 'xhs:delivery:77',
      title: '标题',
      body: '正文',
      tags: ['收纳', '生活'],
      assets: [{
        path,
        originalName: '01.png',
        mediaType: 'image/png',
        byteSize: bytes.length,
        sha256: assetSha,
      }],
    };
    const result = await client.publishBatch([source]);
    assert.equal(calls, 1);
    assert.equal(result[0].source, source);
    assert.equal(result[0].previewId, previewId);
    assert.equal(result[0].noteId, noteId);
    assert.equal(
      result[0].previewUrl,
      `https://preview.example.com/preview?noteId=${noteId}`,
    );
    assert.equal(result[0].reused, false);

    const invalidClient = createPreviewServiceClient({
      baseUrl: 'https://preview.example.com',
      apiKey: 'server-secret',
      fetchImpl: async () => Response.json({
        items: [{
          clientId: 'delivery_77',
          preview: {
            id: previewId,
            publicId: noteId,
            contentHash: 'b'.repeat(64),
            status: 'PUBLISHED',
            publishedAt: 1_789_000_000_000,
          },
          previewUrl: `https://preview.example.com/preview?noteId=${noteId}`,
          reused: false,
        }],
      }, { status: 201 }),
    });
    await assert.rejects(
      invalidClient.publishBatch([source]),
      (error) => error?.code === 'PREVIEW_SERVICE_INVALID_RESPONSE',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('delivery preview upload binds the remote noteId to the immutable delivery entry', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'xhs-delivery-preview-'));
  try {
    const directory = join(storageRoot, 'tasks', '7', 'image-runs', imageRunId);
    const storagePath = join(directory, '01.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await mkdir(directory, { recursive: true });
    await writeFile(storagePath, bytes);
    const binding = {
      deliveryEntryId: 77,
      taskId: 7,
      copyRevisionId: 107,
      imageRunId,
    };
    const task = {
      id: 7,
      state: 'REVIEWED',
      currentCopyRevisionId: 107,
      currentImageRunId: imageRunId,
      copyRevisions: [{
        id: 107,
        content: { copy: { title: '标题', body: '正文', tags: ['收纳'] } },
      }],
      imageRuns: [{ id: imageRunId, result: { images: [{ assetId: 207 }] } }],
      assets: [{ id: 207 }],
    };
    let recorded;
    const repository = {
      listDeliveryPoolTaskIdsForPreview: async ({
        actor, queryPackageIds, includeUnassigned, taskIds, testTaskId, limit,
      }) => {
        assert.equal(actor, admin);
        assert.deepEqual(queryPackageIds, [9]);
        assert.equal(includeUnassigned, false);
        assert.deepEqual(taskIds, [7]);
        assert.equal(testTaskId, null);
        assert.equal(limit, 1);
        return [7];
      },
      getTaskForDelivery: async () => ({ task, binding }),
      assertTasksReadyForDelivery: async (bindings) => {
        assert.deepEqual(bindings, [binding]);
      },
      getAsset: async () => ({
        id: 207,
        taskId: 7,
        imageRunId,
        mediaType: 'image/png',
        originalName: '01.png',
        storagePath,
        byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }),
      recordDeliveryPreviewLinks: async (records, actor) => {
        recorded = records;
        assert.equal(actor, admin);
        return records.map((record) => ({ ...record, currentReady: true }));
      },
    };
    const previewClient = {
      publishBatch: async ([source]) => [{
        source,
        sourceRef: source.sourceRef,
        previewId,
        noteId,
        previewUrl: `https://preview.example.com/?noteId=${noteId}`,
        contentHash,
        publishedAt: 1_789_000_000_000,
        reused: false,
      }],
    };
    const result = await publishDeliveryPreviews({
      repository,
      storageRoot,
      previewClient,
      input: { scope: 'QUERY_PACKAGES', queryPackageIds: [9], taskIds: [7], limit: 1 },
      actor: admin,
    });
    assert.equal(recorded[0].deliveryEntryId, 77);
    assert.equal(recorded[0].noteId, noteId);
    assert.deepEqual(result, {
      scope: 'QUERY_PACKAGES',
      limit: 1,
      requestedCount: 1,
      publishedCount: 1,
      createdCount: 1,
      reusedCount: 0,
      failedCount: 0,
      items: [{
        taskId: 7,
        deliveryEntryId: 77,
        noteId,
        previewUrl: `https://preview.example.com/?noteId=${noteId}`,
        reused: false,
      }],
      failures: [],
    });
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('delivery preview upload rejects TIFF before calling the preview service', async () => {
  const binding = { deliveryEntryId: 77, taskId: 7, copyRevisionId: 107, imageRunId };
  const task = {
    id: 7,
    state: 'REVIEWED',
    currentCopyRevisionId: 107,
    currentImageRunId: imageRunId,
    copyRevisions: [{ id: 107, content: { copy: { title: '标题', body: '', tags: [] } } }],
    imageRuns: [{ id: imageRunId, result: { images: [{ assetId: 207 }] } }],
    assets: [{ id: 207 }],
  };
  let remoteCalls = 0;
  await assert.rejects(publishDeliveryPreviews({
    repository: {
      listDeliveryPoolTaskIdsForPreview: async () => [7],
      getTaskForDelivery: async () => ({ task, binding }),
      getAsset: async () => ({
        id: 207,
        taskId: 7,
        imageRunId,
        mediaType: 'image/tiff',
      }),
      recordDeliveryPreviewLinks: async () => [],
    },
    storageRoot: 'C:\\safe-storage',
    previewClient: { publishBatch: async () => { remoteCalls += 1; } },
    input: { scope: 'QUERY_PACKAGES', queryPackageIds: [9], limit: 10 },
    actor: admin,
  }), (error) => error?.code === 'DELIVERY_PREVIEW_FORMAT_UNSUPPORTED');
  assert.equal(remoteCalls, 0);
});
