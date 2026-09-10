import {
  ApiError,
  MAX_BATCH_MANIFEST_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  readBatchFields,
  readCreateFields,
} from '@/lib/preview-contract';
import { getPublicPreviewUrl } from '@/lib/preview-url';
import { getBindings } from '@/lib/server/bindings';
import { jsonResponse } from '@/lib/server/http';
import {
  insertPreview,
  insertPreviews,
  listPreviews,
  revokePreview,
  type CreatePreviewRecord,
} from '@/lib/server/preview-repository';
import { uploadPreviewOriginals } from '@/lib/server/preview-publisher';

export async function listPreviewsResponse() {
  const previews = await listPreviews();
  return jsonResponse({ previews });
}

export async function createPreviewResponse(request: Request) {
  const uploadedKeys: string[] = [];
  let bucket: R2Bucket | undefined;

  try {
    assertMultipartRequest(request, MAX_TOTAL_IMAGE_BYTES + 1024 * 1024);
    const formData = await request.formData();
    const { title, body, tags, files } = readCreateFields(formData);
    const bindings = getBindings();
    bucket = bindings.files;

    const record = await uploadPreviewOriginals(
      { title, body, tags, files },
      bucket,
      uploadedKeys,
    );
    await insertPreview(record);

    return jsonResponse(
      {
        preview: record.preview,
        previewUrl: getPublicPreviewUrl(request.url, record.preview.publicId),
      },
      { status: 201 },
    );
  } catch (error) {
    await cleanupUploadedObjects(
      bucket,
      uploadedKeys,
      'preview_upload_cleanup_failed',
    );
    throw error;
  }
}

export async function createBatchPreviewResponse(request: Request) {
  const uploadedKeys: string[] = [];
  let bucket: R2Bucket | undefined;

  try {
    assertMultipartRequest(
      request,
      MAX_TOTAL_IMAGE_BYTES + MAX_BATCH_MANIFEST_BYTES + 1024 * 1024,
    );
    const formData = await request.formData();
    const items = readBatchFields(formData);
    const bindings = getBindings();
    bucket = bindings.files;
    const records: Array<{
      clientId: string;
      record: CreatePreviewRecord;
    }> = [];

    for (const [index, item] of items.entries()) {
      try {
        const record = await uploadPreviewOriginals(item, bucket, uploadedKeys);
        records.push({ clientId: item.clientId, record });
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
    }

    await insertPreviews(records.map(({ record }) => record));
    return jsonResponse(
      {
        items: records.map(({ clientId, record }) => ({
          clientId,
          preview: record.preview,
          previewUrl: getPublicPreviewUrl(request.url, record.preview.publicId),
        })),
      },
      { status: 201 },
    );
  } catch (error) {
    await cleanupUploadedObjects(
      bucket,
      uploadedKeys,
      'batch_preview_upload_cleanup_failed',
    );
    throw error;
  }
}

export async function revokePreviewResponse(id: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)
  ) {
    throw new ApiError('预览记录不存在。', 404, 'NOT_FOUND');
  }

  const result = await revokePreview(id);
  if (result.outcome === 'not-found') {
    throw new ApiError('预览记录不存在。', 404, 'NOT_FOUND');
  }
  return jsonResponse({
    status: 'REVOKED',
    changed: result.outcome === 'revoked',
    revokedAt: result.revokedAt,
  });
}

function assertMultipartRequest(request: Request, maximumBytes: number) {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new ApiError(
      '请使用 multipart/form-data 上传预览内容。',
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
  }
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new ApiError(
      '上传内容超过服务允许的总大小。',
      413,
      'UPLOAD_TOO_LARGE',
    );
  }
}

async function cleanupUploadedObjects(
  bucket: R2Bucket | undefined,
  uploadedKeys: string[],
  logName: string,
) {
  if (!bucket || uploadedKeys.length === 0) {
    return;
  }
  try {
    await bucket.delete(uploadedKeys);
  } catch (cleanupError) {
    console.error(logName, cleanupError);
  }
}
