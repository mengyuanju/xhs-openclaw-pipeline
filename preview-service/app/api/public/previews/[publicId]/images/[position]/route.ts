import { MAX_IMAGE_COUNT } from '@/lib/preview-contract';
import { getPreviewObjectStorage } from '@/lib/server/object-storage-runtime';
import { getPublishedImage } from '@/lib/server/preview-repository';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ publicId: string; position: string }> },
) {
  const { publicId, position: rawPosition } = await context.params;
  const position = Number(rawPosition);

  if (
    !/^[0-9a-f]{32}$/iu.test(publicId) ||
    !Number.isInteger(position) ||
    position < 1 ||
    position > MAX_IMAGE_COUNT
  ) {
    return notFound();
  }

  const asset = await getPublishedImage(publicId, position);
  if (!asset) {
    return notFound();
  }

  const storage = getPreviewObjectStorage();
  const object = await storage.getObject(asset.objectKey);
  if (!object) {
    console.error('preview_original_missing', {
      previewId: asset.previewId,
      position: asset.position,
    });
    return notFound();
  }

  const etag = `"${asset.sha256}"`;
  const headers = imageHeaders(asset.mediaType, asset.originalName, etag);
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers });
  }

  headers.set('Content-Length', String(asset.byteSize));
  return new Response(object.body, { headers });
}

function notFound() {
  return new Response('Not found', {
    status: 404,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
    },
  });
}

function imageHeaders(mediaType: string, originalName: string, etag: string) {
  return new Headers({
    'Cache-Control': 'private, max-age=0, must-revalidate',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(originalName)}`,
    'Content-Type': mediaType,
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex',
  });
}
