export const MAX_IMAGE_COUNT = 18;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 60 * 1024 * 1024;
export const MAX_BATCH_PREVIEW_COUNT = 10;
export const MAX_BATCH_IMAGE_COUNT = 60;
export const MAX_BATCH_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_TITLE_LENGTH = 100;
export const MAX_BODY_LENGTH = 30_000;
export const MAX_TAG_COUNT = 20;
export const MAX_TAG_LENGTH = 30;
export const MAX_SOURCE_REF_LENGTH = 200;

const BATCH_CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/u;
const SOURCE_REF_PATTERN = /^[A-Za-z0-9:._-]+$/u;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'INVALID_REQUEST',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface DetectedImage {
  mediaType: string;
  extension: string;
}

export interface CreatePreviewFields {
  title: string;
  body: string;
  tags: string[];
  files: File[];
  sourceRef: string | null;
}

export interface BatchCreateFields extends CreatePreviewFields {
  clientId: string;
}

export function parseTags(value: string): string[] {
  const tags = value
    .split(/[,，\n#]+/u)
    .map((tag) => tag.trim())
    .filter(Boolean);
  const uniqueTags = [...new Set(tags)];

  if (uniqueTags.length > MAX_TAG_COUNT) {
    throw new ApiError(`标签最多 ${MAX_TAG_COUNT} 个。`);
  }
  if (uniqueTags.some((tag) => tag.length > MAX_TAG_LENGTH)) {
    throw new ApiError(`单个标签不能超过 ${MAX_TAG_LENGTH} 个字符。`);
  }

  return uniqueTags;
}

export function validatePreviewFields({
  titleValue,
  bodyValue,
  tagsValue,
  files,
  sourceRefValue,
}: {
  titleValue: unknown;
  bodyValue: unknown;
  tagsValue: unknown;
  files: File[];
  sourceRefValue?: unknown;
}): CreatePreviewFields {
  const title = typeof titleValue === 'string' ? titleValue.trim() : '';
  const body = typeof bodyValue === 'string' ? bodyValue.trim() : '';
  const tags = parseTags(typeof tagsValue === 'string' ? tagsValue : '');
  const sourceRef = typeof sourceRefValue === 'string'
    ? sourceRefValue.trim()
    : '';

  if (!title) {
    throw new ApiError('请填写预览标题。');
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ApiError(`标题不能超过 ${MAX_TITLE_LENGTH} 个字符。`);
  }
  if (body.length > MAX_BODY_LENGTH) {
    throw new ApiError(`正文不能超过 ${MAX_BODY_LENGTH} 个字符。`);
  }
  if (
    sourceRef &&
    (sourceRef.length > MAX_SOURCE_REF_LENGTH ||
      !SOURCE_REF_PATTERN.test(sourceRef))
  ) {
    throw new ApiError('sourceRef 格式不正确。');
  }
  if (files.length === 0) {
    throw new ApiError('请至少选择 1 张原图。');
  }
  if (files.length > MAX_IMAGE_COUNT) {
    throw new ApiError(`一次最多上传 ${MAX_IMAGE_COUNT} 张原图。`);
  }

  let totalBytes = 0;
  for (const file of files) {
    if (file.size <= 0) {
      throw new ApiError(`图片“${file.name || '未命名'}”为空。`);
    }
    if (file.size > MAX_IMAGE_BYTES) {
      throw new ApiError(
        `图片“${file.name || '未命名'}”超过 ${formatBytes(MAX_IMAGE_BYTES)}。`,
        413,
        'IMAGE_TOO_LARGE',
      );
    }
    totalBytes += file.size;
  }
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new ApiError(
      `全部原图合计不能超过 ${formatBytes(MAX_TOTAL_IMAGE_BYTES)}。`,
      413,
      'UPLOAD_TOO_LARGE',
    );
  }

  return { title, body, tags, files, sourceRef: sourceRef || null };
}

export function readCreateFields(formData: FormData): CreatePreviewFields {
  return validatePreviewFields({
    titleValue: formData.get('title'),
    bodyValue: formData.get('body'),
    tagsValue: formData.get('tags'),
    files: readFiles(formData, 'images'),
    sourceRefValue: formData.get('sourceRef'),
  });
}

export function readBatchFields(formData: FormData): BatchCreateFields[] {
  const manifestValue = formData.get('manifest');
  if (typeof manifestValue !== 'string') {
    throw new ApiError('批量请求缺少 manifest。');
  }
  if (
    new TextEncoder().encode(manifestValue).byteLength >
    MAX_BATCH_MANIFEST_BYTES
  ) {
    throw new ApiError(
      '批量文案内容超过服务允许的总大小。',
      413,
      'MANIFEST_TOO_LARGE',
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestValue);
  } catch {
    throw new ApiError('manifest 不是有效的 JSON。');
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ApiError('manifest 必须是对象。');
  }
  const items = (manifest as Record<string, unknown>).items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError('请至少提交 1 条预览内容。');
  }
  if (items.length > MAX_BATCH_PREVIEW_COUNT) {
    throw new ApiError(`每批最多创建 ${MAX_BATCH_PREVIEW_COUNT} 条预览。`);
  }

  const clientIds = new Set<string>();
  const sourceRefs = new Set<string>();
  const parsed = items.map((item, index): BatchCreateFields => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ApiError(`第 ${index + 1} 条：内容格式不正确。`);
    }
    const value = item as Record<string, unknown>;
    const clientId =
      typeof value.clientId === 'string' ? value.clientId.trim() : '';
    if (!BATCH_CLIENT_ID_PATTERN.test(clientId)) {
      throw new ApiError(`第 ${index + 1} 条：clientId 格式不正确。`);
    }
    if (clientIds.has(clientId)) {
      throw new ApiError(`第 ${index + 1} 条：clientId 不能重复。`);
    }
    clientIds.add(clientId);

    try {
      const parsedItem = {
        clientId,
        ...validatePreviewFields({
          titleValue: value.title,
          bodyValue: value.body,
          tagsValue: value.tags,
          files: readFiles(formData, `images.${clientId}`),
          sourceRefValue: value.sourceRef,
        }),
      };
      if (parsedItem.sourceRef) {
        if (sourceRefs.has(parsedItem.sourceRef)) {
          throw new ApiError('sourceRef 不能重复。');
        }
        sourceRefs.add(parsedItem.sourceRef);
      }
      return parsedItem;
    } catch (error) {
      if (error instanceof ApiError) {
        throw new ApiError(
          `第 ${index + 1} 条：${error.message}`,
          error.status,
          error.code,
        );
      }
      throw error;
    }
  });

  for (const [fieldName, entry] of formData.entries()) {
    if (
      entry instanceof File &&
      fieldName.startsWith('images.') &&
      !clientIds.has(fieldName.slice('images.'.length))
    ) {
      throw new ApiError(`图片字段“${fieldName}”没有对应的批量条目。`);
    }
  }

  const imageCount = parsed.reduce(
    (total, item) => total + item.files.length,
    0,
  );
  if (imageCount > MAX_BATCH_IMAGE_COUNT) {
    throw new ApiError(`每批原图合计不能超过 ${MAX_BATCH_IMAGE_COUNT} 张。`);
  }
  const totalBytes = parsed.reduce(
    (total, item) =>
      total + item.files.reduce((itemTotal, file) => itemTotal + file.size, 0),
    0,
  );
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new ApiError(
      `每批原图合计不能超过 ${formatBytes(MAX_TOTAL_IMAGE_BYTES)}。`,
      413,
      'UPLOAD_TOO_LARGE',
    );
  }

  return parsed;
}

function readFiles(formData: FormData, fieldName: string) {
  return formData
    .getAll(fieldName)
    .filter((entry): entry is File => entry instanceof File);
}

export function detectImage(bytes: Uint8Array): DetectedImage | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mediaType: 'image/png', extension: 'png' };
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { mediaType: 'image/jpeg', extension: 'jpg' };
  }

  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end));

  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return { mediaType: 'image/webp', extension: 'webp' };
  }

  if (
    bytes.length >= 6 &&
    (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')
  ) {
    return { mediaType: 'image/gif', extension: 'gif' };
  }

  if (
    bytes.length >= 12 &&
    ascii(4, 8) === 'ftyp' &&
    ['avif', 'avis'].includes(ascii(8, 12))
  ) {
    return { mediaType: 'image/avif', extension: 'avif' };
  }

  return null;
}

export async function sha256Hex(value: ArrayBuffer | string) {
  const bytes =
    typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
