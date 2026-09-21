// Versioned defaults; changing dimensions also requires renderer coordinate support.
export const STANDALONE_IMAGE_EDITOR_LIMITS = Object.freeze({
  version: 1, width: 1086, height: 1448, maxUploadBytes: 5 * 1024 * 1024,
  maxPixels: 16_000_000, maxNormalizedBytes: 10 * 1024 * 1024,
  maxImages: 5, formats: ['image/png', 'image/jpeg', 'image/webp'],
});
export const STANDALONE_IMAGE_EDIT_EXECUTOR_VERSION = 13;
