import { createHash } from 'node:crypto';

const baseUrl = (
  process.env.PREVIEW_BASE_URL ?? 'http://localhost:3100'
).replace(/\/$/u, '');
const originalBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const originalHash = createHash('sha256').update(originalBytes).digest('hex');

const form = new FormData();
form.set('title', '本地闭环验证');
form.set('body', '这条记录用于验证原图直存、公开预览与链接撤销。');
form.set('tags', 'smoke，本地验证');
form.append(
  'images',
  new Blob([originalBytes], { type: 'image/png' }),
  'smoke-original.png',
);

const createdResponse = await fetch(`${baseUrl}/api/v1/previews`, {
  method: 'POST',
  body: form,
});
const created = await readJson(createdResponse, 201);
const preview = created.preview;
assert(preview?.id, 'Create response has no preview id.');
assert(preview?.publicId, 'Create response has no public id.');

const publicUrl = `${baseUrl}/preview?noteId=${preview.publicId}`;
assert(
  created.previewUrl === publicUrl,
  `Create response returned unexpected previewUrl: ${created.previewUrl}`,
);
const pageResponse = await fetch(publicUrl);
assert(
  pageResponse.status === 200,
  `Public page returned ${pageResponse.status}.`,
);
assert(
  (await pageResponse.text()).includes('本地闭环验证'),
  'Public page does not contain the published title.',
);

const imageUrl = `${baseUrl}/api/public/previews/${preview.publicId}/images/1`;
const imageResponse = await fetch(imageUrl);
assert(
  imageResponse.status === 200,
  `Original image returned ${imageResponse.status}.`,
);
const downloadedBytes = Buffer.from(await imageResponse.arrayBuffer());
const downloadedHash = createHash('sha256')
  .update(downloadedBytes)
  .digest('hex');
assert(
  downloadedHash === originalHash,
  `Original bytes changed: ${originalHash} != ${downloadedHash}.`,
);

const revokeResponse = await fetch(
  `${baseUrl}/api/v1/previews/${preview.id}/revoke`,
  { method: 'POST' },
);
const revoked = await readJson(revokeResponse, 200);
assert(revoked.status === 'REVOKED', 'Preview was not revoked.');

const revokedImageResponse = await fetch(imageUrl);
assert(
  revokedImageResponse.status === 404,
  `Revoked original is still public (${revokedImageResponse.status}).`,
);
const revokedPageResponse = await fetch(publicUrl);
assert(
  revokedPageResponse.status === 200 &&
    (await revokedPageResponse.text()).includes('这个预览已停止访问'),
  'Revoked page does not show the unavailable state.',
);

console.log(
  JSON.stringify(
    {
      ok: true,
      previewId: preview.id,
      publicUrl,
      originalSha256: originalHash,
      originalBytesPreserved: true,
      revokedImageStatus: revokedImageResponse.status,
    },
    null,
    2,
  ),
);

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
