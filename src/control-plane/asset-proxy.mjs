const assetPath = path => /^\/v1\/assets\/[1-9]\d*$/u.test(path);

/** @returns {Record<string, string>} */
export function assetConditionalHeaders(path, request) {
  const etag = request.headers.get('if-none-match');
  // Next must skip its shared fetch cache, while the origin can still validate the
  // browser's private copy. An implicit no-cache header would force a full body.
  return assetPath(path) && ['GET', 'HEAD'].includes(request.method) && etag
    ? { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } : {};
}

/** @returns {Record<string, string>} */
export function assetResponseHeaders(path, upstream) {
  const etag = upstream.headers.get('etag');
  if (assetPath(path) && [200, 304].includes(upstream.status) && etag
    && upstream.headers.get('cache-control') === 'private, no-cache') {
    return { 'Cache-Control': 'private, no-cache', ETag: etag, Vary: 'Cookie' };
  }
  return { 'Cache-Control': 'no-store' };
}

export function thumbnailUrl(src) {
  return /^\/api\/control-plane\/v1\/assets\/[1-9]\d*$/u.test(src) ? `${src}?variant=thumbnail` : src;
}
