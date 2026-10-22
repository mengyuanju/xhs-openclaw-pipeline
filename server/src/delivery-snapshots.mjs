import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import yauzl from 'yauzl';
import { ControlPlaneConflictError, normalizeTaskId, normalizeUuid } from './domain.mjs';
import { withOriginalDeliveryQuery } from './delivery-copy-query.mjs';
import { publishImmutableFile, withImmutableFileLock } from './immutable-file-publication.mjs';

const MAX_MEMBER_BYTES = 1024 ** 3;
const MAX_TOTAL_BYTES = 10 * 1024 ** 3;
const MAX_INLINE_BYTES = 32 * 1024 ** 2;
const MAX_INLINE_TOTAL_BYTES = 64 * 1024 ** 2;
const MAX_SNAPSHOT_BYTES = 128 * 1024 ** 2;
const MAX_ENTRIES = 100_000;
const HASH = /^[a-f0-9]{64}$/u;
const IMAGE = /\.(?:png|jpe?g|webp|gif|avif|bmp|tiff?|heic|heif|svg)$/iu;
const TASK = /^((?:[^/]+\/)?任务-(\d+)-资源包)(?:\.zip|\/(.+))$/u;
const hashBytes = value => createHash('sha256').update(value).digest('hex');
const keyFor = value => value.normalize('NFC').toLocaleLowerCase('zh-CN');
const failure = message => new ControlPlaneConflictError('DELIVERY_SOURCE_MISSING', message);
const ambiguous = taskId => new ControlPlaneConflictError('DELIVERY_SOURCE_AMBIGUOUS', `任务 #${taskId} 的快照成员重复`);
const safeSignal = signal => signal ?? new AbortController().signal;

function safeName(name) {
  if (typeof name !== 'string' || !name || name.length > 4096 || name.includes('\\')
      || yauzl.validateFileName(name) || /[\u0000-\u001f\u007f:]/u.test(name)
      || name.split('/').some(part => !part || part === '.' || /[ .]$/u.test(part))) {
    throw new TypeError('交付快照文件路径无效');
  }
  return name;
}

function safeSize(value, maximum = MAX_TOTAL_BYTES) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError('交付快照文件大小超过上限');
  return value;
}

function contained(root, candidate) {
  const difference = relative(root, candidate);
  return difference !== '' && !isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`);
}

async function storageDirectory(root, name) {
  const base = await realpath(root);
  const directory = join(base, name);
  await mkdir(directory, { recursive: true });
  const actual = await realpath(directory);
  if (!contained(base, actual) || (await lstat(directory)).isSymbolicLink()) throw failure('交付快照目录越出图片存储范围');
  return directory;
}

async function imagePath(root, storagePath) {
  safeName(storagePath);
  const base = await realpath(root), candidate = resolve(base, ...storagePath.split('/'));
  if (!contained(base, candidate)) throw failure('快照图片路径越出图片存储范围');
  const metadata = await lstat(candidate).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw failure(`快照图片缺失：${storagePath}`);
  const actual = await realpath(candidate);
  if (!contained(base, actual)) throw failure('快照图片路径越出图片存储范围');
  return { path: actual, metadata };
}

async function hashFile(path, signal) {
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    signal?.throwIfAborted();
    hash.update(chunk); byteSize += chunk.length;
  }
  return { sha256: hash.digest('hex'), byteSize };
}

async function verifyImage(root, file, signal) {
  const source = await imagePath(root, file.storagePath);
  if (source.metadata.size !== file.byteSize) throw failure(`快照图片大小已变化：${file.storagePath}`);
  const actual = await hashFile(source.path, signal);
  if (actual.byteSize !== file.byteSize || actual.sha256 !== file.sha256) throw failure(`快照图片校验失败：${file.storagePath}`);
  return source.path;
}

function manifestDigest(snapshot) {
  const { manifestSha256, ...manifest } = snapshot;
  return hashBytes(JSON.stringify(manifest));
}

function validateSnapshot(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.entries) || !Array.isArray(input.members)
      || input.entries.length < 1 || input.entries.length > MAX_ENTRIES
      || input.members.length < 1 || input.members.length > MAX_ENTRIES) throw failure('交付快照格式无效');
  normalizeUuid(input.publicId, 'deliveryBatchId');
  if (!HASH.test(input.sourceArchive?.sha256 ?? '') || safeSize(input.sourceArchive?.byteSize) < 1
      || !HASH.test(input.manifestSha256 ?? '') || manifestDigest(input) !== input.manifestSha256) {
    throw failure('交付快照清单校验失败');
  }
  const entries = new Map(), names = new Set();
  let total = 0, inlineTotal = 0;
  for (const file of input.entries) {
    safeName(file.entryName);
    const key = keyFor(file.entryName);
    if (names.has(key)) throw failure('交付快照包含重复文件');
    names.add(key); entries.set(file.entryName, file);
    total += safeSize(file.byteSize, MAX_MEMBER_BYTES);
    if (total > MAX_TOTAL_BYTES || !HASH.test(file.sha256 ?? '')) throw failure('交付快照文件清单无效');
    if (file.taskId != null) normalizeTaskId(file.taskId);
    if (file.kind === 'image') safeName(file.storagePath);
    else if (file.kind === 'text') {
      if (typeof file.contentBase64 !== 'string' || file.byteSize > MAX_INLINE_BYTES
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.contentBase64)) throw failure('交付快照文本无效');
      const bytes = Buffer.from(file.contentBase64, 'base64');
      if (bytes.length !== file.byteSize || hashBytes(bytes) !== file.sha256) throw failure('交付快照文本校验失败');
      inlineTotal += bytes.length;
      if (inlineTotal > MAX_INLINE_TOTAL_BYTES) throw new RangeError('交付快照文本总量超过上限');
    } else throw failure('交付快照文件类型无效');
  }
  const tasks = new Set(), selectedEntries = new Set();
  for (const member of input.members) {
    normalizeTaskId(member.taskId); safeName(member.directory);
    if (tasks.has(member.taskId) || !Array.isArray(member.files) || !member.files.length) throw ambiguous(member.taskId);
    tasks.add(member.taskId);
    let bytes = 0;
    const memberNames = new Set();
    for (const entryName of member.files) {
      const file = entries.get(entryName);
      if (!file || file.taskId !== member.taskId || !entryName.startsWith(`${member.directory}/`)
          || memberNames.has(keyFor(entryName)) || selectedEntries.has(entryName)) throw ambiguous(member.taskId);
      memberNames.add(keyFor(entryName)); selectedEntries.add(entryName); bytes += file.byteSize;
    }
    if (bytes !== member.byteSize || bytes > MAX_MEMBER_BYTES) throw failure(`任务 #${member.taskId} 的快照大小无效`);
  }
  if (input.entries.some(file => file.taskId != null && !selectedEntries.has(file.entryName))) throw failure('交付快照成员清单不完整');
  if (input.taskSnapshots != null) {
    if (!Array.isArray(input.taskSnapshots) || input.taskSnapshots.length !== tasks.size) throw failure('交付快照任务元数据不完整');
    const metadataTasks = new Set();
    for (const task of input.taskSnapshots) {
      normalizeTaskId(task?.id);
      if (!tasks.has(task.id) || metadataTasks.has(task.id)) throw failure('交付快照任务元数据重复或无效');
      metadataTasks.add(task.id);
    }
  }
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_SNAPSHOT_BYTES) throw new RangeError('交付快照文件超过上限');
  return input;
}

async function temporaryDirectory(root) {
  const exports = await storageDirectory(root, '.delivery-exports');
  const directory = join(exports, randomUUID());
  await mkdir(directory);
  return { directory, cleanup: async () => {
    if (!contained(exports, resolve(directory)) || (await lstat(directory).catch(() => null))?.isSymbolicLink()) throw failure('临时交付目录路径无效');
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}

async function withZip(path, operation) {
  const zip = await yauzl.openPromise(path, { lazyEntries: true, autoClose: false, strictFileNames: true });
  try { return await operation(zip); }
  finally { zip.close(); }
}

export async function createDeliverySnapshot(root, archivePath, publicId, options = {}) {
  publicId = normalizeUuid(publicId, 'deliveryBatchId');
  const signal = safeSignal(options.signal);
  signal.throwIfAborted();
  const metadata = await stat(archivePath);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_TOTAL_BYTES) throw failure('原交付压缩包无效或过大');
  const sourceArchive = await hashFile(archivePath, signal);
  if ((options.expectedSha256 != null && options.expectedSha256 !== sourceArchive.sha256)
      || (options.expectedByteSize != null && Number(options.expectedByteSize) !== sourceArchive.byteSize)) throw failure('原交付压缩包校验失败');
  const snapshot = { version: 1, publicId, sourceArchive, entries: [], members: [] };
  if (options.taskSnapshots != null) {
    if (!Array.isArray(options.taskSnapshots)) throw new TypeError('交付快照任务元数据无效');
    const fields = ['id', 'query', 'issuedQuery', 'sourceQueryPackageName', 'sourceClientBatchCode',
      'currentCopyRevisionId', 'currentImageRunId', 'copyRevisions', 'imageRuns', 'assets',
      'xiaohongshuLinks', 'xiaohongshuSearchStatus', 'xiaohongshuSearchBlockedReason'];
    snapshot.taskSnapshots = JSON.parse(JSON.stringify(options.taskSnapshots.map(task => Object.fromEntries(
      fields.filter(field => task?.[field] !== undefined).map(field => [field, task[field]]),
    ))));
  }
  const members = new Map(), usedNames = new Set();
  let count = 0, total = 0, inlineTotal = 0;
  const addFile = async (zip, entry, entryName, member) => {
    signal.throwIfAborted(); safeName(entryName);
    const key = keyFor(entryName);
    if (usedNames.has(key)) throw ambiguous(member?.taskId ?? '');
    usedNames.add(key);
    const byteSize = safeSize(entry.uncompressedSize, MAX_MEMBER_BYTES);
    total += byteSize;
    if (total > MAX_TOTAL_BYTES) throw new RangeError('交付快照内容超过 10 GiB');
    const stream = await zip.openReadStreamPromise(entry), hash = createHash('sha256');
    const isImage = IMAGE.test(entryName), chunks = [];
    let read = 0;
    if (!isImage && byteSize > MAX_INLINE_BYTES) { stream.destroy(); throw new RangeError('交付快照文本文件超过 32 MiB'); }
    try {
      for await (const chunk of stream) {
        signal.throwIfAborted(); read += chunk.length;
        if (read > byteSize) throw failure('交付压缩包成员大小无效');
        hash.update(chunk); if (!isImage) chunks.push(chunk);
      }
    } finally { stream.destroy(); }
    if (read !== byteSize) throw failure('交付压缩包成员不完整');
    const file = { entryName, ...(member ? { taskId: member.taskId } : {}), kind: isImage ? 'image' : 'text', byteSize, sha256: hash.digest('hex') };
    if (isImage) {
      if (typeof options.resolveImage !== 'function') throw failure(`无法定位快照图片：${entryName}`);
      const found = await options.resolveImage({ sha256: file.sha256, byteSize, entryName, taskId: member?.taskId });
      file.storagePath = found?.storagePath?.replaceAll('\\', '/');
      await verifyImage(root, file, signal);
    } else {
      inlineTotal += byteSize;
      if (inlineTotal > MAX_INLINE_TOTAL_BYTES) throw new RangeError('交付快照文本总量超过 64 MiB');
      file.contentBase64 = Buffer.concat(chunks).toString('base64');
    }
    snapshot.entries.push(file);
    if (member) {
      member.files.push(entryName); member.byteSize += byteSize;
      if (member.byteSize > MAX_MEMBER_BYTES) throw new RangeError(`任务 #${member.taskId} 的内容超过 1 GiB`);
    }
  };
  const memberFor = (taskId, directory, legacy) => {
    const current = members.get(taskId);
    if (current && (legacy || current.legacy || current.directory !== directory)) throw ambiguous(taskId);
    if (current) return current;
    const member = { taskId, directory, files: [], byteSize: 0, legacy };
    members.set(taskId, member); return member;
  };
  await withZip(archivePath, async zip => {
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      if (++count > MAX_ENTRIES) throw new RangeError('交付压缩包文件数量超过上限');
      if (entry.fileName.endsWith('/')) { safeName(entry.fileName.slice(0, -1)); continue; }
      safeName(entry.fileName);
      const match = TASK.exec(entry.fileName);
      if (!match) { await addFile(zip, entry, entry.fileName); continue; }
      const taskId = normalizeTaskId(match[2]), member = memberFor(taskId, match[1], !match[3]);
      if (match[3]) { await addFile(zip, entry, entry.fileName, member); continue; }
      safeSize(entry.uncompressedSize, MAX_MEMBER_BYTES);
      const temporary = await temporaryDirectory(root);
      try {
        const innerPath = join(temporary.directory, 'legacy.zip');
        await pipeline(await zip.openReadStreamPromise(entry), createWriteStream(innerPath, { flags: 'wx' }), { signal });
        await withZip(innerPath, async inner => {
          for await (const innerEntry of inner.eachEntry()) {
            signal.throwIfAborted();
            if (++count > MAX_ENTRIES) throw new RangeError('交付压缩包文件数量超过上限');
            if (innerEntry.fileName.endsWith('/')) { safeName(innerEntry.fileName.slice(0, -1)); continue; }
            await addFile(inner, innerEntry, `${member.directory}/${innerEntry.fileName}`, member);
          }
        });
      } finally { await temporary.cleanup(); }
    }
  });
  snapshot.members = [...members.values()].map(({ legacy, ...member }) => member);
  snapshot.manifestSha256 = manifestDigest(snapshot);
  return validateSnapshot(snapshot);
}

export function deliverySnapshotPath(root, publicId) {
  return join(root, '.delivery-snapshots', `${normalizeUuid(publicId, 'deliveryBatchId')}.json`);
}

export async function saveDeliverySnapshot(root, input, options = {}) {
  const snapshot = validateSnapshot(input);
  const directory = await storageDirectory(root, '.delivery-snapshots');
  const path = join(directory, `${normalizeUuid(snapshot.publicId, 'deliveryBatchId')}.json`);
  const contents = JSON.stringify(snapshot);
  if (Buffer.byteLength(contents) > MAX_SNAPSHOT_BYTES) throw new RangeError('交付快照文件超过上限');
  try {
    await publishImmutableFile(path, contents, { ...options, maxBytes: MAX_SNAPSHOT_BYTES,
      compareExisting: async () => JSON.stringify(await loadDeliverySnapshot(root, snapshot.publicId)) === contents });
  } catch (error) {
    if (error.code === 'IMMUTABLE_FILE_CONFLICT') throw new ControlPlaneConflictError('DELIVERY_SNAPSHOT_CONFLICT', '已有交付快照与此次内容不一致');
    throw error;
  }
  return snapshot;
}

export async function loadDeliverySnapshot(root, publicId) {
  const directory = await storageDirectory(root, '.delivery-snapshots');
  const path = join(directory, `${normalizeUuid(publicId, 'deliveryBatchId')}.json`), metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_SNAPSHOT_BYTES) throw failure('交付快照缺失或无效');
  let snapshot;
  try { snapshot = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw failure('交付快照无法读取'); }
  if (snapshot.publicId !== normalizeUuid(publicId, 'deliveryBatchId')) throw failure('交付快照批次不一致');
  return validateSnapshot(snapshot);
}

export async function removeDeliverySnapshot(root, publicId, options = {}) {
  const directory = await storageDirectory(root, '.delivery-snapshots');
  const path = join(directory, `${normalizeUuid(publicId, 'deliveryBatchId')}.json`);
  await withImmutableFileLock(path, ({ fs }) => fs.rm(path, { force: true }), options);
}

export async function verifyDeliverySnapshotSources(root, input, { signal } = {}) {
  const snapshot = validateSnapshot(input);
  for (const file of snapshot.entries) {
    signal?.throwIfAborted();
    if (file.kind === 'image') await verifyImage(root, file, signal);
  }
  return snapshot;
}

export async function inspectSnapshotSources(root, rows, { signal } = {}) {
  const batches = new Map(), members = [];
  let totalBytes = 0;
  for (const row of rows) {
    signal?.throwIfAborted();
    const id = normalizeUuid(row.batch_public_id, 'deliveryBatchId');
    if (!batches.has(id)) batches.set(id, await loadDeliverySnapshot(root, id));
    const snapshot = batches.get(id);
    if (snapshot.sourceArchive.sha256 !== row.source_sha256 || snapshot.sourceArchive.byteSize !== Number(row.source_byte_size)) throw failure(`批次 ${row.batch_code ?? id} 的快照来源校验失败`);
    const source = snapshot.members.find(member => member.taskId === Number(row.task_id));
    if (!source) throw failure(`快照中找不到任务 #${row.task_id}`);
    const entries = new Map(snapshot.entries.map(file => [file.entryName, file]));
    const files = [];
    for (const entryName of source.files) {
      signal?.throwIfAborted();
      const file = entries.get(entryName);
      if (file.kind === 'image') await verifyImage(root, file, signal);
      const name = file.entryName.slice(source.directory.length + 1);
      files.push({ name, entryName: file.entryName, key: keyFor(name), byteSize: file.byteSize, snapshotFile: file });
    }
    members.push({ row, directory: source.directory, files, byteSize: source.byteSize, snapshot: true, storageRoot: root });
    totalBytes += source.byteSize;
    if (totalBytes > MAX_TOTAL_BYTES) throw new RangeError('汇总内容超过 10 GiB，请缩小范围');
  }
  return { members, totalBytes };
}

export async function openSnapshotFile(root, input, { signal } = {}) {
  const file = input.snapshotFile ?? input;
  if (file.kind === 'text') {
    const bytes = Buffer.from(file.contentBase64, 'base64');
    if (bytes.length !== file.byteSize || hashBytes(bytes) !== file.sha256) throw failure('交付快照文本校验失败');
    signal?.throwIfAborted();
    return Readable.from([bytes], { objectMode: false });
  }
  const { path, metadata } = await imagePath(root, file.storagePath);
  if (metadata.size !== file.byteSize) throw failure(`快照图片大小已变化：${file.storagePath}`);
  // The file reader owns cancellation. Subscribing this generator wrapper to
  // the same signal can race its asynchronous return()/reader destruction.
  return Readable.from((async function* () {
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(path, { signal })) {
      hash.update(chunk); bytes += chunk.length;
      if (bytes > file.byteSize) throw failure(`快照图片大小已变化：${file.storagePath}`);
      yield chunk;
    }
    if (bytes !== file.byteSize || hash.digest('hex') !== file.sha256) throw failure(`快照图片校验失败：${file.storagePath}`);
  })(), { objectMode: false });
}

async function appendFile(archive, stream, name, signal) {
  signal.throwIfAborted();
  if (archive.destroyed) { stream.destroy(); throw new Error('交付文件输出已中断'); }
  const done = once(archive, 'entry', { signal });
  const closed = finished(stream, { cleanup: true }).catch(() => {});
  const onError = error => archive.emit('error', error);
  const onAbort = () => stream.destroy(signal.reason);
  stream.once('error', onError); signal.addEventListener('abort', onAbort, { once: true });
  try { archive.append(stream, { name }); await done; }
  finally {
    signal.removeEventListener('abort', onAbort);
    stream.destroy();
    // Iterator teardown can emit an error after destroy() has returned.
    await closed;
    stream.removeListener('error', onError);
  }
}

export async function appendSnapshotMember(archive, member, rawSignal) {
  const signal = safeSignal(rawSignal), directory = safeName(member.outputDirectory ?? member.directory);
  for (const file of member.files) {
    signal.throwIfAborted(); safeName(file.name);
    const stream = await openSnapshotFile(member.storageRoot, file, { signal });
    const content = /\.txt$/iu.test(file.name)
      ? Readable.from(withOriginalDeliveryQuery(stream, { issuedQuery: member.row.issued_query, query: member.row.query }), { objectMode: false }) : stream;
    if (content !== stream) stream.once('error', error => content.destroy(error));
    try { await appendFile(archive, content, `${directory}/${file.name}`, signal); }
    finally { stream.destroy(); content.destroy(); }
  }
}

export async function writeSnapshotBatchArchive(root, input, outputPath, { signal: rawSignal } = {}) {
  const signal = safeSignal(rawSignal), snapshot = validateSnapshot(input);
  signal.throwIfAborted();
  const exports = await storageDirectory(root, '.delivery-exports'), actualParent = await realpath(resolve(outputPath, '..'));
  if (!contained(exports, actualParent) || !contained(actualParent, resolve(outputPath))) throw failure('临时交付文件路径无效');
  const output = createWriteStream(outputPath, { flags: 'wx' }), archive = new ZipArchive({ forceZip64: true, zlib: { level: 6 } });
  let transferError;
  const transfer = pipeline(archive, output, { signal }).catch(error => { transferError = error; archive.emit('error', error); });
  // Keep an error listener even between individual entry writes.
  archive.on('error', () => {});
  try {
    for (const file of snapshot.entries) {
      if (transferError) throw transferError;
      await appendFile(archive, await openSnapshotFile(root, file, { signal }), file.entryName, signal);
    }
    await archive.finalize(); await transfer;
    if (transferError) throw transferError;
    return { archivePath: outputPath, byteSize: (await stat(outputPath)).size };
  } catch (error) {
    archive.abort(); output.destroy(error); await transfer;
    await rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function stageSnapshotBatchArchive(root, snapshot, options = {}) {
  const signal = safeSignal(options.signal);
  signal.throwIfAborted();
  const temporary = await temporaryDirectory(root);
  try {
    const staged = await writeSnapshotBatchArchive(root, snapshot, join(temporary.directory, 'batch.zip'), { signal });
    return { ...staged, cleanup: temporary.cleanup };
  } catch (error) { await temporary.cleanup(); throw error; }
}

const IMAGE_MEDIA_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml' };

function snapshotCopy(files, taskId) {
  const linkedQuery = files.filter(file => file.kind === 'text' && /(?:^|\/)小红书链接(?:-\d+)?\.txt$/u.test(file.entryName))
    .map(file => /^\uFEFF?Query[：:]([^\r\n]*)/u.exec(Buffer.from(file.contentBase64, 'base64').toString('utf8'))?.[1]).find(value => value != null);
  const candidates = files.filter(file => file.kind === 'text' && /\.txt$/iu.test(file.entryName)).map(file => {
    const text = Buffer.from(file.contentBase64, 'base64').toString('utf8');
    const match = /^\uFEFF?(?:原始[ \t]*Query[：:]([^\r\n]*)\r?\n\r?\n)?标题[：:]([\s\S]*?)\r?\n\r?\n文案内容[：:]\r?\n([\s\S]*)$/u.exec(text);
    if (!match) return null;
    let body = match[3], tags = [];
    const tagLine = /(?:\r?\n){2}标签[：:]([^\r\n]*)(?:\r?\n)*$/u.exec(body);
    if (tagLine) {
      const values = tagLine[1].trim().split(/\s+/u).filter(Boolean);
      if (values.every(tag => /^#[^#\s]+$/u.test(tag))) {
        tags = values; body = body.slice(0, tagLine.index);
      } else body = body.replace(/\r?\n$/u, '');
    } else body = body.replace(/\r?\n$/u, '');
    return { query: match[1] ?? linkedQuery ?? '', copy: { title: match[2], body, tags } };
  }).filter(Boolean);
  if (candidates.length !== 1) throw failure(`任务 #${taskId} 的快照文案无法唯一解析`);
  return candidates[0];
}

// History exports use frozen metadata or the original TXT, never current tasks.
// Synthetic asset IDs are local to each task; the supplied loader receives both.
export function buildSnapshotSpreadsheetTasks(input, bindings = []) {
  const snapshot = validateSnapshot(input), entries = new Map(snapshot.entries.map(file => [file.entryName, file]));
  const frozen = new Map((snapshot.taskSnapshots ?? []).map(task => [task.id, task]));
  const byTask = new Map(bindings.map(binding => [Number(binding.taskId ?? binding.task_id), binding]));
  return snapshot.members.map(member => {
    const saved = frozen.get(member.taskId), binding = byTask.get(member.taskId) ?? {};
    const files = member.files.map(entryName => entries.get(entryName));
    const copyRevisionId = binding.copyRevisionId ?? binding.copy_revision_id ?? saved?.currentCopyRevisionId ?? member.taskId;
    const imageRunId = binding.imageRunId ?? binding.image_run_id ?? saved?.currentImageRunId ?? `snapshot-${member.taskId}`;
    const revision = saved?.copyRevisions?.find(item => Number(item.id) === Number(saved.currentCopyRevisionId));
    const parsed = revision?.content ? null : snapshotCopy(files, member.taskId);
    const assets = files.filter(file => file.kind === 'image').map((file, index) => {
      const originalName = file.entryName.slice(member.directory.length + 1), extension = originalName.split('.').at(-1).toLowerCase();
      const mediaType = IMAGE_MEDIA_TYPES[extension];
      if (!mediaType) throw failure(`任务 #${member.taskId} 的快照图片格式不支持 Excel 导出`);
      return { id: index + 1, taskId: member.taskId, imageRunId, mediaType, originalName,
        storagePath: file.storagePath, sha256: file.sha256, byteSize: file.byteSize, snapshotFile: file };
    });
    if (!assets.length) throw failure(`任务 #${member.taskId} 的快照缺少图片`);
    let links = saved?.xiaohongshuLinks;
    if (!Array.isArray(links)) {
      const linkFile = files.find(file => file.kind === 'text' && /(?:^|\/)小红书链接(?:-\d+)?\.txt$/u.test(file.entryName));
      const text = linkFile ? Buffer.from(linkFile.contentBase64, 'base64').toString('utf8') : '';
      links = [...text.matchAll(/^(?:\d+\.[ \t]*)?(https?:\/\/[^\s]+)[ \t]*$/gmu)].map((match, index) => ({ url: match[1], rank: index + 1, title: null }));
    }
    return {
      id: member.taskId,
      query: binding.query ?? binding.query_snapshot ?? saved?.query ?? parsed?.query ?? '',
      sourceQueryPackageName: binding.queryPackageName ?? binding.query_package_name_snapshot ?? saved?.sourceQueryPackageName ?? null,
      sourceClientBatchCode: binding.clientBatchCode ?? binding.client_batch_code_snapshot ?? saved?.sourceClientBatchCode ?? null,
      currentCopyRevisionId: copyRevisionId, currentImageRunId: imageRunId,
      copyRevisions: [{ id: copyRevisionId, content: revision?.content ?? { copy: parsed.copy } }],
      imageRuns: [{ id: imageRunId, result: { images: assets.map(asset => ({ assetId: asset.id })) } }],
      assets, xiaohongshuLinks: links,
      xiaohongshuSearchStatus: saved?.xiaohongshuSearchStatus ?? (links.length ? 'SUCCEEDED' : null),
      xiaohongshuSearchBlockedReason: saved?.xiaohongshuSearchBlockedReason ?? null,
    };
  });
}
