import {
  ApiError,
  MAX_TOTAL_IMAGE_BYTES,
  readCreateFields,
} from '@/lib/preview-contract';
import { getPublicPreviewUrl } from '@/lib/preview-url';
import { getBindings } from '@/lib/server/bindings';
import {
  assertSameOrigin,
  errorResponse,
  jsonResponse,
} from '@/lib/server/http';
import { insertPreview, listPreviews } from '@/lib/server/preview-repository';
import { uploadPreviewOriginals } from '@/lib/server/preview-publisher';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const previews = await listPreviews();
    return jsonResponse({ previews });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const uploadedKeys: string[] = [];
  let bucket: R2Bucket | undefined;

  try {
    assertSameOrigin(request);
    const contentType = request.headers.get('Content-Type') ?? '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      throw new ApiError(
        '请使用 multipart/form-data 上传预览内容。',
        415,
        'UNSUPPORTED_MEDIA_TYPE',
      );
    }
    const contentLength = Number(request.headers.get('Content-Length'));
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_TOTAL_IMAGE_BYTES + 1024 * 1024
    ) {
      throw new ApiError(
        '上传内容超过服务允许的总大小。',
        413,
        'UPLOAD_TOO_LARGE',
      );
    }

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
    if (bucket && uploadedKeys.length > 0) {
      try {
        await bucket.delete(uploadedKeys);
      } catch (cleanupError) {
        console.error('preview_upload_cleanup_failed', cleanupError);
      }
    }
    return errorResponse(error);
  }
}
