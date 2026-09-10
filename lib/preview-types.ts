export type PreviewStatus = 'PUBLISHED' | 'REVOKED';

export interface PreviewSummary {
  id: string;
  publicId: string;
  title: string;
  body: string;
  tags: string[];
  status: PreviewStatus;
  imageCount: number;
  contentHash: string;
  createdAt: number;
  publishedAt: number;
  revokedAt: number | null;
}

export interface PublicPreview {
  publicId: string;
  title: string;
  body: string;
  tags: string[];
  status: PreviewStatus;
  imageCount: number;
  publishedAt: number;
  revokedAt: number | null;
}

export interface PreviewAssetRecord {
  id: string;
  previewId: string;
  position: number;
  objectKey: string;
  originalName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  createdAt: number;
}
