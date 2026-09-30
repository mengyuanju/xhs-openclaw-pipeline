export type ReferenceImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

export const REFERENCE_UPLOAD_MAX_BYTES: number;
export function detectReferenceImageMediaType(bytes: Uint8Array): ReferenceImageMediaType | null;
export function referenceUploadSizeMessage(byteLength: number): string;
export function referenceImageTypeMismatchMessage(bytes: Uint8Array, declaredMediaType: string, options?: { contentValidated?: boolean }): string;
