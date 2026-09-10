import {
  ApiError,
  MAX_BATCH_MANIFEST_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  readBatchFields,
} from '@/lib/preview-contract';
import { getPublicPreviewUrl } from '@/lib/preview-url';
import { getBindings } from '@/lib/server/bindings';
import {
  assertSameOrigin,
  errorResponse,
  jsonResponse,
} from '@/lib/server/http';
import {
  insertPreviews,
  type CreatePreviewRecord,
} from '@/lib/server/preview-repository';
import { uploadPreviewOriginals } from '@/lib/server/preview-publisher';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const uploadedKeys: string[] = [];
  let bucket: R2Bucket | undefined;

  try {
    assertSameOrigin(request);
    const contentType = request.headers.get('Content-Type') ?? '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      throw new ApiError(
        '请使用 multipart/form-data 上传批量预览内容。',
        415,
        'UNSUPPORTED_MEDIA_TYPE',
      );
    }
    const contentLength = Number(request.headers.get('Content-Length'));
    if (
      Number.isFinite(contentLength) &&
      contentLength >
        MAX_TOTAL_IMAGE_BYTES + MAX_BATCH_MANIFEST_BYTES + 1024 * 1024
    ) {
      throw new ApiError(
        '批量上传内容超过服务允许的总大小。',
        413,
        'UPLOAD_TOO_LARGE',
      );
    }

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
    if (bucket && uploadedKeys.length > 0) {
      try {
        await bucket.delete(uploadedKeys);
      } catch (cleanupError) {
        console.error('batch_preview_upload_cleanup_failed', cleanupError);
      }
    }
    return errorResponse(error);
  }
}
