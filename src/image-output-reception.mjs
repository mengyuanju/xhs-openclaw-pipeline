import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import sharp from 'sharp';

function receptionError(message, code = 'IMAGE_OUTPUT_INVALID') {
  return Object.assign(new Error(message), { code });
}

// Validate the bytes we will publish, not a filename or just the PNG header.
export async function verifiedPngBytes(path, { roots, startedAt }) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw receptionError('Image output path is invalid');
  const actual = await realpath(path);
  const allowedRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => resolve(root))));
  const contained = allowedRoots.some((root) => {
    const child = relative(root, actual);
    return child && !child.startsWith('..') && !isAbsolute(child);
  });
  const info = await lstat(path);
  if (!contained || !info.isFile() || info.isSymbolicLink() || info.size < 1
    || info.size > 32 * 1024 * 1024 || info.mtimeMs < startedAt - 2000) {
    throw receptionError('Image output is outside this invocation, stale or invalid');
  }
  const bytes = await readFile(actual);
  if (bytes.length > 32 * 1024 * 1024) throw receptionError('Image output exceeds the size limit');
  try {
    const metadata = await sharp(bytes, { failOn: 'error', limitInputPixels: 40_000_000 }).metadata();
    if (metadata.format !== 'png' || !metadata.width || !metadata.height) throw new Error('not PNG');
    await sharp(bytes, { failOn: 'error', limitInputPixels: 40_000_000 }).stats();
  } catch {
    throw receptionError('Image output is not a complete valid PNG');
  }
  return bytes;
}
