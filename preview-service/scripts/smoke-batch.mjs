import { createHash } from 'node:crypto';

const baseUrl = (
  process.env.PREVIEW_BASE_URL ?? 'http://localhost:3100'
).replace(/\/$/u, '');
const apiKey = process.env.PREVIEW_API_KEY;
if (!apiKey) {
  throw new Error('Set PREVIEW_API_KEY before running the smoke test.');
}
const apiHeaders = { Authorization: `Bearer ${apiKey}` };
const originalBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const originalHash = createHash('sha256').update(originalBytes).digest('hex');
const sourceRefSuffix = `${Date.now()}-${crypto.randomUUID()}`;

const beforeIds = new Set((await listPreviews()).map((preview) => preview.id));
const invalidForm = makeManifest([
  {
    clientId: 'atomic-a',
    title: '不应写入 A',
    body: '',
    tags: '',
    bytes: originalBytes,
    fileName: 'valid-first.png',
  },
  {
    clientId: 'atomic-b',
    title: '不应写入 B',
    body: '',
    tags: '',
    bytes: Buffer.from('not-an-image'),
    fileName: 'invalid-second.png',
  },
]);
const invalidResponse = await fetch(`${baseUrl}/api/v1/previews/batch`, {
  method: 'POST',
  headers: apiHeaders,
  body: invalidForm,
});
assert(
  invalidResponse.status === 415,
  `Invalid batch returned ${invalidResponse.status}, expected 415.`,
);
const afterInvalid = await listPreviews();
assert(
  afterInvalid.every((preview) => beforeIds.has(preview.id)),
  'Invalid batch left partial preview metadata behind.',
);

const validItems = [
  {
    clientId: 'batch-a',
    sourceRef: `smoke:batch:a:${sourceRefSuffix}`,
    title: '批量闭环验证 A',
    body: '第一条批量预览，用于验证独立链接和原图直存。',
    tags: 'batch，原图',
    bytes: originalBytes,
    fileName: 'batch-original-a.png',
  },
  {
    clientId: 'batch-b',
    sourceRef: `smoke:batch:b:${sourceRefSuffix}`,
    title: '批量闭环验证 B',
    body: '第二条批量预览，用于验证整批写入。',
    tags: 'batch，事务',
    bytes: originalBytes,
    fileName: 'batch-original-b.png',
  },
];
const validForm = makeManifest(validItems);
const createdResponse = await fetch(`${baseUrl}/api/v1/previews/batch`, {
  method: 'POST',
  headers: apiHeaders,
  body: validForm,
});
const created = await readJson(createdResponse, 201);
assert(created.items?.length === 2, 'Batch response does not contain 2 items.');
assert(
  created.items.map((item) => item.clientId).join(',') === 'batch-a,batch-b',
  'Batch response order or client ids changed.',
);
assert(
  created.items.every((item) => item.reused === false),
  'First idempotent batch unexpectedly reused an existing record.',
);

const retryResponse = await fetch(`${baseUrl}/api/v1/previews/batch`, {
  method: 'POST',
  headers: apiHeaders,
  body: makeManifest(validItems),
});
const retried = await readJson(retryResponse, 201);
assert(
  retried.items?.every((item, index) =>
    item.reused === true && item.preview?.id === created.items[index].preview.id),
  'Idempotent batch retry did not reuse the original preview records.',
);

for (const [index, item] of created.items.entries()) {
  const preview = item.preview;
  assert(preview?.id, `Batch item ${index + 1} has no preview id.`);
  assert(preview?.publicId, `Batch item ${index + 1} has no public id.`);

  const publicUrl = `${baseUrl}/preview?noteId=${preview.publicId}`;
  assert(
    item.previewUrl === publicUrl,
    `Batch item ${index + 1} returned unexpected previewUrl.`,
  );
  const pageResponse = await fetch(publicUrl);
  assert(
    pageResponse.status === 200,
    `Batch public page ${index + 1} returned ${pageResponse.status}.`,
  );
  assert(
    (await pageResponse.text()).includes(
      `批量闭环验证 ${index === 0 ? 'A' : 'B'}`,
    ),
    `Batch public page ${index + 1} does not contain its title.`,
  );

  const imageUrl = `${baseUrl}/api/public/previews/${preview.publicId}/images/1`;
  const imageResponse = await fetch(imageUrl);
  assert(
    imageResponse.status === 200,
    `Batch original ${index + 1} returned ${imageResponse.status}.`,
  );
  const downloadedHash = createHash('sha256')
    .update(Buffer.from(await imageResponse.arrayBuffer()))
    .digest('hex');
  assert(
    downloadedHash === originalHash,
    `Batch original ${index + 1} bytes changed.`,
  );

  const revokeResponse = await fetch(
    `${baseUrl}/api/v1/previews/${preview.id}/revoke`,
    { method: 'POST', headers: apiHeaders },
  );
  const revoked = await readJson(revokeResponse, 200);
  assert(
    revoked.status === 'REVOKED',
    `Batch item ${index + 1} was not revoked.`,
  );
  const revokedImageResponse = await fetch(imageUrl);
  assert(
    revokedImageResponse.status === 404,
    `Revoked batch original ${index + 1} is still public.`,
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      atomicFailureLeftNoMetadata: true,
      createdCount: created.items.length,
      previewIds: created.items.map((item) => item.preview.id),
      publicUrls: created.items.map((item) => item.previewUrl),
      originalSha256: originalHash,
      originalBytesPreserved: true,
      idempotentRetryReusedOriginals: true,
      revokedAfterVerification: true,
    },
    null,
    2,
  ),
);

function makeManifest(items) {
  const form = new FormData();
  form.set(
    'manifest',
    JSON.stringify({
      items: items.map(({ clientId, sourceRef, title, body, tags }) => ({
        clientId,
        sourceRef,
        title,
        body,
        tags,
      })),
    }),
  );
  for (const item of items) {
    form.append(
      `images.${item.clientId}`,
      new Blob([item.bytes], { type: 'image/png' }),
      item.fileName,
    );
  }
  return form;
}

async function listPreviews() {
  const response = await fetch(`${baseUrl}/api/v1/previews`, {
    cache: 'no-store',
    headers: apiHeaders,
  });
  const data = await readJson(response, 200);
  return data.previews ?? [];
}

async function readJson(response, expectedStatus) {
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(
      `${response.url} returned ${response.status}, expected ${expectedStatus}: ${text}`,
    );
  }
  return JSON.parse(text);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
