export interface StoredPreviewObject {
  body: ReadableStream<Uint8Array>;
}

export interface PreviewObjectStorage {
  putObject(
    objectKey: string,
    content: ArrayBuffer,
    metadata: { contentType: string; sha256: string },
  ): Promise<void>;
  getObject(objectKey: string): Promise<StoredPreviewObject | null>;
  deleteObjects(objectKeys: string[]): Promise<void>;
}

export function createR2ObjectStorage(bucket: R2Bucket): PreviewObjectStorage {
  return Object.freeze({
    async putObject(
      objectKey: string,
      content: ArrayBuffer,
      metadata: { contentType: string; sha256: string },
    ) {
      await bucket.put(objectKey, content, {
        httpMetadata: { contentType: metadata.contentType },
        customMetadata: { sha256: metadata.sha256 },
      });
    },

    async getObject(objectKey: string) {
      const object = await bucket.get(objectKey);
      return object ? { body: object.body } : null;
    },

    async deleteObjects(objectKeys: string[]) {
      if (objectKeys.length > 0) {
        await bucket.delete(objectKeys);
      }
    },
  });
}
