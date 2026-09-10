export function getPublicPreviewPath(publicId: string) {
  return `/preview?noteId=${encodeURIComponent(publicId)}`;
}

export function getPublicPreviewUrl(baseUrl: string, publicId: string) {
  return new URL(getPublicPreviewPath(publicId), baseUrl).href;
}
