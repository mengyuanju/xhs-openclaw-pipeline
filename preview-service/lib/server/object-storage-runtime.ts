import { getFilesBinding } from '@/lib/server/bindings';
import {
  createR2ObjectStorage,
  type PreviewObjectStorage,
} from '@/lib/server/object-storage';

export function getPreviewObjectStorage(): PreviewObjectStorage {
  return createR2ObjectStorage(getFilesBinding());
}
