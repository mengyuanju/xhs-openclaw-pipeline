import {
  ApiError,
  detectImage,
  sha256Hex,
  type CreatePreviewFields,
} from '@/lib/preview-contract';
import type { PreviewAssetRecord, PreviewSummary } from '@/lib/preview-types';
import type { CreatePreviewRecord } from '@/lib/server/preview-repository';

export async function uploadPreviewOriginals(
  fields: CreatePreviewFields,
  bucket: R2Bucket,
  uploadedKeys: string[],
): Promise<CreatePreviewRecord> {
  const previewId = crypto.randomUUID();
  const publicId = crypto.randomUUID().replaceAll('-', '');
  const createdAt = Date.now();
  const assets: PreviewAssetRecord[] = [];

  for (const [index, file] of fields.files.entries()) {
    const buffer = await file.arrayBuffer();
    const detected = detectImage(new Uint8Array(buffer));
    if (!detected) {
      throw new ApiError(
        `“${file.name || `第 ${index + 1} 张图片`}”不是受支持的原图格式。`,
        415,
        'UNSUPPORTED_IMAGE',
      );
    }

    const sha256 = await sha256Hex(buffer);
    const position = index + 1;
    const objectKey = `previews/${previewId}/originals/${String(position).padStart(2, '0')}-${sha256}.${detected.extension}`;
    const originalName = normalizeFileName(
      file.name,
      position,
      detected.extension,
    );

    await bucket.put(objectKey, buffer, {
      httpMetadata: { contentType: detected.mediaType },
      customMetadata: { sha256 },
    });
    uploadedKeys.push(objectKey);

    assets.push({
      id: crypto.randomUUID(),
      previewId,
      position,
      objectKey,
      originalName,
      mediaType: detected.mediaType,
      byteSize: file.size,
      sha256,
      createdAt,
    });
  }

  const contentHash = await sha256Hex(
    JSON.stringify({
      title: fields.title,
      body: fields.body,
      tags: fields.tags,
      images: assets.map((asset) => asset.sha256),
    }),
  );
  const preview: PreviewSummary = {
    id: previewId,
    publicId,
    title: fields.title,
    body: fields.body,
    tags: fields.tags,
    status: 'PUBLISHED',
    imageCount: assets.length,
    contentHash,
    createdAt,
    publishedAt: createdAt,
    revokedAt: null,
  };

  return { preview, assets };
}

function normalizeFileName(name: string, position: number, extension: string) {
  let withoutControls = '';
  let characterCount = 0;
  for (const character of name) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint >= 32 &&
      codePoint !== 127 &&
      (codePoint < 0xd800 || codePoint > 0xdfff) &&
      characterCount < 240
    ) {
      withoutControls += character;
      characterCount += 1;
    }
  }
  const cleaned = withoutControls.trim();
  return cleaned || `image-${position}.${extension}`;
}
