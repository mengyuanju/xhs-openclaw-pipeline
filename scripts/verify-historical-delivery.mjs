import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, readdir, realpath, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from '@excel.js/exceljs';
import yauzl from 'yauzl';
import { buildSnapshotSpreadsheetTasks, loadDeliverySnapshot, openSnapshotFile, stageSnapshotBatchArchive } from '../server/src/delivery-snapshots.mjs';
import { deliveryCopyFromContent } from '../server/src/delivery-source.mjs';
import { MAX_DELIVERY_SPREADSHEET_TASKS, writeDeliverySpreadsheetExport } from '../server/src/delivery-spreadsheet.mjs';
import { normalizeUuid } from '../server/src/domain.mjs';

const MAX_BYTES = 64 * 1024 ** 2;
const SNAPSHOT_FILE = /^([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.json$/iu;
const EXCEL_IMAGE = /\.(?:png|jpe?g|gif)$/iu;
const hash = value => createHash('sha256').update(value).digest('hex');

function check(condition, code) {
  if (condition) return;
  const error = new Error(code); error.code = code; throw error;
}

function positiveLimit(value) {
  check(Number.isSafeInteger(value) && value > 0, 'INVALID_HISTORICAL_VERIFICATION_LIMIT');
  return value;
}

async function checkedRoot(input) {
  check(typeof input === 'string' && isAbsolute(input), 'HISTORICAL_STORAGE_ROOT_MUST_BE_ABSOLUTE');
  const path = resolve(input), volume = parse(path).root;
  let current = volume;
  for (const part of relative(volume, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    check(info.isDirectory() && !info.isSymbolicLink(), 'HISTORICAL_STORAGE_LINK_REJECTED');
  }
  const root = await realpath(path), snapshots = join(root, '.delivery-snapshots'), info = await lstat(snapshots);
  check(info.isDirectory() && !info.isSymbolicLink(), 'HISTORICAL_SNAPSHOT_DIRECTORY_INVALID');
  return root;
}

function snapshotSize(snapshot) {
  return snapshot.entries.reduce((bytes, file) => bytes + file.byteSize, 0);
}

async function withZip(path, operation) {
  const zip = await yauzl.openPromise(path, { lazyEntries: true, autoClose: false, strictFileNames: true });
  try { return await operation(zip); }
  finally {
    if (zip.isOpen) { const closed = once(zip, 'close'); zip.close(); await closed; }
  }
}

/** Select using snapshot metadata only; no images or original ZIPs are read. */
export async function findSmallHistoricalBatch(storageRoot, { maxBytes = MAX_BYTES, maxTasks = 20, signal } = {}) {
  positiveLimit(maxBytes); positiveLimit(maxTasks);
  const root = await checkedRoot(storageRoot);
  let selected;
  for (const entry of await readdir(join(root, '.delivery-snapshots'), { withFileTypes: true })) {
    signal?.throwIfAborted();
    const match = SNAPSHOT_FILE.exec(entry.name);
    if (!match) continue;
    check(entry.isFile() && !entry.isSymbolicLink(), 'HISTORICAL_SNAPSHOT_FILE_INVALID');
    const snapshot = await loadDeliverySnapshot(root, normalizeUuid(match[1]));
    const byteSize = snapshotSize(snapshot), images = snapshot.entries.filter(file => file.kind === 'image');
    if (byteSize > maxBytes || snapshot.members.length > Math.min(maxTasks, MAX_DELIVERY_SPREADSHEET_TASKS)
        || !images.length || images.some(file => !EXCEL_IMAGE.test(file.entryName))) continue;
    try { buildSnapshotSpreadsheetTasks(snapshot); } catch { continue; }
    const candidate = { publicId: snapshot.publicId, taskCount: snapshot.members.length,
      fileCount: snapshot.entries.length, byteSize, imageBytes: images.reduce((bytes, file) => bytes + file.byteSize, 0) };
    if (!selected || candidate.byteSize < selected.byteSize || (candidate.byteSize === selected.byteSize && candidate.publicId < selected.publicId)) selected = candidate;
  }
  check(selected, 'NO_SMALL_HISTORICAL_BATCH_AVAILABLE');
  return selected;
}

async function verifyArchive(path, snapshot, signal) {
  let index = 0, totalBytes = 0;
  await withZip(path, async zip => {
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted();
      check(index < snapshot.entries.length, 'HISTORICAL_ZIP_UNEXPECTED_MEMBER');
      const file = snapshot.entries[index++];
      check(entry.fileName === file.entryName && entry.uncompressedSize === file.byteSize, 'HISTORICAL_ZIP_MEMBER_MISMATCH');
      const digest = createHash('sha256'), stream = await zip.openReadStreamPromise(entry);
      let bytes = 0;
      try {
        for await (const chunk of stream) {
          signal?.throwIfAborted(); bytes += chunk.length;
          check(bytes <= file.byteSize, 'HISTORICAL_ZIP_MEMBER_TOO_LARGE');
          digest.update(chunk);
        }
      } finally { stream.destroy(); }
      check(bytes === file.byteSize && digest.digest('hex') === file.sha256, 'HISTORICAL_ZIP_CONTENT_MISMATCH');
      totalBytes += bytes;
    }
  });
  check(index === snapshot.entries.length, 'HISTORICAL_ZIP_MISSING_MEMBER');
  return { verified: true, memberCount: index, uncompressedBytes: totalBytes, byteSize: (await stat(path)).size };
}

function spreadsheetText(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/gu, '\uFFFD');
}

async function verifySpreadsheet(root, snapshot, bindings, directory, maxBytes, signal) {
  const tasks = buildSnapshotSpreadsheetTasks(snapshot, bindings);
  const generated = await writeDeliverySpreadsheetExport(tasks, async (task, assetId) => {
    const asset = task.assets.find(candidate => candidate.id === Number(assetId));
    check(asset && asset.byteSize <= maxBytes, 'HISTORICAL_SPREADSHEET_ASSET_INVALID');
    const chunks = [];
    for await (const chunk of await openSnapshotFile(root, asset.snapshotFile, { signal })) chunks.push(chunk);
    return { ...asset, content: Buffer.concat(chunks) };
  }, directory, { signal, maxImageBytes: maxBytes });
  check(generated.partCount === 1 && generated.fileExtension === '.xlsx', 'HISTORICAL_SPREADSHEET_EXPECTED_ONE_SMALL_WORKBOOK');
  signal?.throwIfAborted();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(generated.artifactPath);
  signal?.throwIfAborted();
  check(workbook.worksheets.length === 1, 'HISTORICAL_SPREADSHEET_WORKSHEET_COUNT_MISMATCH');
  const worksheet = workbook.worksheets[0], expectedImages = new Map();
  check(worksheet.actualRowCount === tasks.length + 1, 'HISTORICAL_SPREADSHEET_TASK_COUNT_MISMATCH');
  for (const [index, task] of tasks.entries()) {
    const revision = task.copyRevisions.find(item => Number(item.id) === Number(task.currentCopyRevisionId));
    const copy = deliveryCopyFromContent(revision?.content);
    check(copy, 'HISTORICAL_SPREADSHEET_COPY_MISSING');
    const title = spreadsheetText(copy.title), body = spreadsheetText(copy.body);
    const expected = [task.sourceClientBatchCode ?? '未归属甲方批次', task.sourceQueryPackageName ?? '未归属词包', task.query,
      `${title}${title && body ? '\n\n' : ''}${body}`];
    for (const [column, value] of expected.entries()) {
      const cell = worksheet.getRow(index + 2).getCell(column + 1);
      check(!cell.formula && spreadsheetText(cell.value) === spreadsheetText(value), 'HISTORICAL_SPREADSHEET_FROZEN_TEXT_MISMATCH');
    }
    for (const [imageIndex, asset] of task.assets.entries()) expectedImages.set(`${index + 1}:${imageIndex + 5}`, asset);
  }
  const images = worksheet.getImages();
  check(images.length === expectedImages.size, 'HISTORICAL_SPREADSHEET_IMAGE_COUNT_MISMATCH');
  for (const image of images) {
    const key = `${image.range.tl.nativeRow}:${image.range.tl.nativeCol}`, asset = expectedImages.get(key);
    check(asset, 'HISTORICAL_SPREADSHEET_IMAGE_POSITION_MISMATCH');
    const embedded = workbook.getImage(Number(image.imageId));
    check(embedded?.buffer, 'HISTORICAL_SPREADSHEET_IMAGE_MISSING');
    const bytes = Buffer.from(embedded.buffer);
    check(bytes.length === asset.byteSize && hash(bytes) === asset.sha256, 'HISTORICAL_SPREADSHEET_IMAGE_BYTES_MISMATCH');
    expectedImages.delete(key);
  }
  check(expectedImages.size === 0, 'HISTORICAL_SPREADSHEET_IMAGE_MISSING');
  return { verified: true, taskCount: tasks.length, embeddedImageCount: images.length, partCount: generated.partCount,
    byteSize: (await stat(generated.artifactPath)).size,
    emptyFrozenQueryCount: tasks.filter(task => !String(task.query ?? '').trim()).length, bindingsProvided: bindings.length };
}

/** Create disposable historical ZIP/Excel exports, verify frozen bytes, then remove them. */
export async function verifyHistoricalDeliverySnapshot(storageRoot, publicId, {
  maxBytes = MAX_BYTES, spreadsheet = true, bindings = [], signal,
} = {}) {
  positiveLimit(maxBytes);
  check(Array.isArray(bindings), 'HISTORICAL_BINDINGS_INVALID');
  signal?.throwIfAborted();
  const root = await checkedRoot(storageRoot);
  const id = normalizeUuid(publicId ?? (await findSmallHistoricalBatch(root, { maxBytes, signal })).publicId, 'batchId');
  const snapshot = await loadDeliverySnapshot(root, id), totalBytes = snapshotSize(snapshot);
  check(totalBytes <= maxBytes, 'HISTORICAL_BATCH_EXCEEDS_SMOKE_CHECK_BYTE_LIMIT');
  if (spreadsheet) check(snapshot.members.length <= MAX_DELIVERY_SPREADSHEET_TASKS, 'HISTORICAL_BATCH_EXCEEDS_SPREADSHEET_TASK_LIMIT');
  let staged, report;
  try {
    staged = await stageSnapshotBatchArchive(root, snapshot, { signal });
    const archive = await verifyArchive(staged.archivePath, snapshot, signal);
    const excel = spreadsheet ? await verifySpreadsheet(root, snapshot, bindings, dirname(staged.archivePath), maxBytes, signal) : { skipped: true };
    report = { verified: true, publicId: id, snapshotManifestSha256: snapshot.manifestSha256,
      taskCount: snapshot.members.length, fileCount: snapshot.entries.length, sourceArchive: snapshot.sourceArchive,
      archive, spreadsheet: excel };
  } finally { await staged?.cleanup(); }
  if (staged) check(!await access(dirname(staged.archivePath)).then(() => true, () => false), 'HISTORICAL_TEMPORARY_EXPORT_NOT_CLEANED');
  return { ...report, temporaryCleaned: true };
}

export async function main(args = process.argv.slice(2)) {
  const roots = args.filter(arg => arg.startsWith('--storage-root=')), ids = args.filter(arg => arg.startsWith('--public-id=')), limits = args.filter(arg => arg.startsWith('--max-bytes='));
  check(roots.length === 1 && ids.length <= 1 && limits.length <= 1
    && args.every(arg => /^--(?:storage-root|public-id|max-bytes)=/u.test(arg) || arg === '--zip-only'), 'INVALID_HISTORICAL_VERIFICATION_ARGUMENTS');
  const controller = new AbortController(), cancel = () => controller.abort(new DOMException('Historical export verification cancelled', 'AbortError'));
  process.once('SIGINT', cancel);
  try {
    return await verifyHistoricalDeliverySnapshot(roots[0].slice('--storage-root='.length), ids[0]?.slice('--public-id='.length), {
      maxBytes: limits.length ? Number(limits[0].slice('--max-bytes='.length)) : MAX_BYTES,
      spreadsheet: !args.includes('--zip-only'), signal: controller.signal,
    });
  } finally { process.off('SIGINT', cancel); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main())); }
  catch (error) { console.error(JSON.stringify({ verified: false, code: error.code ?? 'HISTORICAL_VERIFICATION_FAILED' })); process.exitCode = 1; }
}
