import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
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

export async function receiveOpenClawImage({ result, directory, requestedPath, outputPath, startedAt }) {
  let envelope;
  try { envelope = JSON.parse(String(result.stdout ?? '')); } catch { /* Legacy CLI can omit JSON. */ }
  let paths;
  if (envelope && Object.hasOwn(envelope, 'outputs')) {
    if (envelope.ok !== true || !Array.isArray(envelope.outputs) || envelope.outputs.length > 10) {
      throw receptionError('Image output metadata is invalid');
    }
    if (envelope.outputs.some((item) => typeof item?.path !== 'string' || !isAbsolute(item.path))) {
      throw receptionError('Image output metadata contains an invalid path');
    }
    paths = [...new Set(envelope.outputs.map((item) => resolve(item.path)))];
  } else {
    // Only the isolated, exact path can be accepted without structured metadata.
    paths = await lstat(requestedPath).then(() => [requestedPath], (error) => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    });
  }
  if (paths.length === 0) return false;
  if (paths.length !== 1) {
    throw receptionError('Multiple image outputs are ambiguous; candidates retained, generation was not replayed', 'IMAGE_OUTPUT_AMBIGUOUS');
  }
  const bytes = await verifiedPngBytes(paths[0], { roots: [directory], startedAt });
  // Never overwrite a prior output. I/O failure is reception failure, not a reason to regenerate.
  await writeFile(outputPath, bytes, { flag: 'wx' });
  return true;
}
