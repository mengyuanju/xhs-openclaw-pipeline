import {
  ApiError,
  MAX_BATCH_MANIFEST_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  readBatchFields,
  readCreateFields,
} from '@/lib/preview-contract';
import { getPublicPreviewUrl } from '@/lib/preview-url';
import { jsonResponse } from '@/lib/server/http';
import {
  type PreviewObjectStorage,
} from '@/lib/server/object-storage';
import { getPreviewObjectStorage } from '@/lib/server/object-storage-runtime';
import {
  insertPreview,
  insertPreviews,
  findPreviewsBySourceRefs,
  listPreviewsPage,
  revokePreview,
  type CreatePreviewRecord,
} from '@/lib/server/preview-repository';
import {
  calculatePreviewContentHash,
  uploadPreviewOriginals,
} from '@/lib/server/preview-publisher';

export async function listPreviewsResponse(request: Request) {
  const url = new URL(request.url);
  const rawPage = Number(url.searchParams.get('page'));
  const rawPageSize = Number(url.searchParams.get('pageSize'));
  const searchField = url.searchParams.get('searchField');
  const search = url.searchParams.get('q')?.trim();
  const status = parseStatus(url.searchParams.get('status'));

  const listResult = await listPreviewsPage({
    page: Number.isFinite(rawPage) ? rawPage : 1,
    pageSize: Number.isFinite(rawPageSize) ? rawPageSize : 20,
    search,
    searchField: searchField === 'query' ? 'query' : 'title',
    status,
  });
  return jsonResponse(listResult);
}

export async function createPreviewResponse(request: Request) {
  const uploadedKeys: string[] = [];
  let storage: PreviewObjectStorage | undefined;

  try {
    assertMultipartRequest(request, MAX_TOTAL_IMAGE_BYTES + 1024 * 1024);
    const formData = await request.formData();
    const fields = readCreateFields(formData);
    const existing = await existingPreviewFor(fields);
    if (existing) {
      if (existing.status !== 'PUBLISHED') {
        throw new ApiError(
          'sourceRef 对应的预览已撤销。',
          409,
          'SOURCE_REF_REVOKED',
        );
      }
      return jsonResponse({
        preview: existing,
        previewUrl: getPublicPreviewUrl(request.url, existing.publicId),
        reused: true,
      });
    }
    storage = getPreviewObjectStorage();

    const record = await uploadPreviewOriginals(
      fields,
      storage,
      uploadedKeys,
    );
    await insertPreview(record);

    return jsonResponse(
      {
        preview: record.preview,
        previewUrl: getPublicPreviewUrl(request.url, record.preview.publicId),
        reused: false,
      },
      { status: 201 },
    );
  } catch (error) {
    await cleanupUploadedObjects(
      storage,
      uploadedKeys,
      'preview_upload_cleanup_failed',
    );
    throw error;
  }
}

export async function createBatchPreviewResponse(request: Request) {
  const uploadedKeys: string[] = [];
  let storage: PreviewObjectStorage | undefined;

  try {
    assertMultipartRequest(
      request,
      MAX_TOTAL_IMAGE_BYTES + MAX_BATCH_MANIFEST_BYTES + 1024 * 1024,
    );
    const formData = await request.formData();
    const items = readBatchFields(formData);
    const existingBySourceRef = await findPreviewsBySourceRefs(
      items.flatMap((item) => (item.sourceRef ? [item.sourceRef] : [])),
    );
    storage = getPreviewObjectStorage();
    const records: Array<{
      clientId: string;
      record: CreatePreviewRecord | null;
      preview: CreatePreviewRecord['preview'];
      reused: boolean;
    }> = [];

    for (const [index, item] of items.entries()) {
      try {
        const existing = item.sourceRef
          ? existingBySourceRef.get(item.sourceRef)
          : undefined;
        if (existing) {
          if (existing.status !== 'PUBLISHED') {
            throw new ApiError(
              'sourceRef 对应的预览已撤销。',
              409,
              'SOURCE_REF_REVOKED',
            );
          }
          const incomingHash = await calculatePreviewContentHash(item);
          if (incomingHash !== existing.contentHash) {
            throw new ApiError(
              'sourceRef 已绑定其他内容。',
              409,
              'SOURCE_REF_CONFLICT',
            );
          }
          records.push({
            clientId: item.clientId,
            record: null,
            preview: existing,
            reused: true,
          });
          continue;
        }
        const record = await uploadPreviewOriginals(item, storage, uploadedKeys);
        records.push({
          clientId: item.clientId,
          record,
          preview: record.preview,
          reused: false,
        });
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

    await insertPreviews(
      records.flatMap(({ record }) => (record ? [record] : [])),
    );
    return jsonResponse(
      {
        items: records.map(({ clientId, preview, reused }) => ({
          clientId,
          preview,
          previewUrl: getPublicPreviewUrl(request.url, preview.publicId),
          reused,
        })),
      },
      { status: 201 },
    );
  } catch (error) {
    await cleanupUploadedObjects(
      storage,
      uploadedKeys,
      'batch_preview_upload_cleanup_failed',
    );
    throw error;
  }
}

async function existingPreviewFor(fields: ReturnType<typeof readCreateFields>) {
  if (!fields.sourceRef) return null;
  const existing = (await findPreviewsBySourceRefs([fields.sourceRef])).get(
    fields.sourceRef,
  );
  if (!existing) return null;
  if ((await calculatePreviewContentHash(fields)) !== existing.contentHash) {
    throw new ApiError(
      'sourceRef 已绑定其他内容。',
      409,
      'SOURCE_REF_CONFLICT',
    );
  }
  return existing;
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

function parseStatus(
  statusValue: string | null,
): 'PUBLISHED' | 'REVOKED' | undefined {
  if (statusValue === 'PUBLISHED' || statusValue === 'REVOKED') {
    return statusValue;
  }
  return undefined;
}

async function cleanupUploadedObjects(
  storage: PreviewObjectStorage | undefined,
  uploadedKeys: string[],
  logName: string,
) {
  if (!storage || uploadedKeys.length === 0) {
    return;
  }
  try {
    await storage.deleteObjects(uploadedKeys);
  } catch (cleanupError) {
    console.error(logName, cleanupError);
  }
}
