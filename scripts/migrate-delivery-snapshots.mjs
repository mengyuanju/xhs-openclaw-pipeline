import assert from 'node:assert/strict';
import { lstat, readdir, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createDeliverySnapshot, saveDeliverySnapshot, loadDeliverySnapshot,
  inspectSnapshotSources, verifyDeliverySnapshotSources } from '../server/src/delivery-snapshots.mjs';
import { registerDeliverySnapshotAssets } from '../server/src/delivery-snapshot-assets.mjs';
import { connectDatabase, isMain, loadConfiguration, safeError } from '../server/scripts/database-common.mjs';

function inside(root, path) {
  const difference = relative(resolve(root), resolve(path));
  return difference !== '' && !isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`);
}

// Check every path component as well as the resolved destination. A regular
// file inside a junction is still a regular file according to lstat(file).
async function checkedPath(root, path, { optional = false, directory = false } = {}) {
  assert.ok(inside(root, path), 'Storage path is outside the configured root');
  const parts = relative(root, resolve(path)).split(sep);
  let current = root, metadata;
  for (const part of parts) {
    current = join(current, part);
    metadata = await lstat(current).catch(error => {
      if (optional && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!metadata) return null;
    assert.ok(!metadata.isSymbolicLink(), 'Linked storage directories or files are not allowed');
    assert.ok(inside(root, await realpath(current)), 'Resolved storage path is outside the configured root');
  }
  assert.ok(directory ? metadata.isDirectory() : metadata.isFile(), 'Unexpected storage file type');
  return metadata;
}

export async function migrateDeliverySnapshots(client, storageRoot, {
  apply = false, removeArchives = false, onProgress = () => {},
} = {}) {
  assert.ok(!removeArchives || apply, 'Removing ZIPs requires --apply');
  const configuredRoot = resolve(storageRoot);
  assert.ok((await lstat(configuredRoot)).isDirectory() && !(await lstat(configuredRoot)).isSymbolicLink(), 'Storage root must be a real directory');
  const root = await realpath(configuredRoot);
  if (removeArchives) {
    const active = (await client.query("SELECT id FROM delivery_archive_jobs WHERE status IN ('QUEUED','RUNNING')")).rows;
    assert.equal(active.length, 0, 'Archive jobs must be idle before removing historical ZIPs');
  }
  const batches = (await client.query('SELECT id,public_id,archive_sha256,archive_byte_size FROM delivery_batches ORDER BY id')).rows;
  const imageRows = (await client.query(`SELECT id,task_id,storage_path,sha256,byte_size
    FROM assets WHERE media_type LIKE 'image/%' AND content_cleared_at IS NULL ORDER BY id`)).rows;
  const candidates = new Map();
  for (const asset of imageRows) {
    if (!inside(root, asset.storage_path)) continue;
    const key = `${asset.sha256}:${asset.byte_size}`;
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(asset);
  }
  const result = { batches: batches.length, snapshots: 0, reused: 0, removedFiles: 0, removedBytes: 0, failures: [] };
  for (const batch of batches) {
    const archivePath = join(root, '.delivery-batches', `${batch.public_id}.zip`);
    try {
      await checkedPath(root, archivePath, { optional: true });
      let snapshot;
      try { snapshot = await loadDeliverySnapshot(root, batch.public_id); result.reused += 1; }
      catch (error) {
        if ((await stat(join(root, '.delivery-snapshots', `${batch.public_id}.json`)).catch(() => null))) throw error;
        snapshot = await createDeliverySnapshot(root, archivePath, batch.public_id, {
          expectedSha256: batch.archive_sha256,
          expectedByteSize: Number(batch.archive_byte_size),
          resolveImage: async ({ sha256, byteSize, taskId }) => {
            const matching = candidates.get(`${sha256}:${byteSize}`) ?? [];
            const owned = matching.filter(asset => Number(asset.task_id) === Number(taskId));
            for (const asset of owned) {
              if (await checkedPath(root, asset.storage_path, { optional: true })) {
                return { storagePath: relative(root, asset.storage_path).replaceAll('\\', '/') };
              }
            }
            return null;
          },
        });
      }
      assert.equal(snapshot.sourceArchive.sha256, batch.archive_sha256, 'Snapshot source does not match the batch');
      assert.equal(snapshot.sourceArchive.byteSize, Number(batch.archive_byte_size), 'Snapshot size does not match the batch');
      await verifyDeliverySnapshotSources(root, snapshot);
      const rows = snapshot.members.map((member, index) => ({
        item_id: index + 1, task_id: member.taskId, batch_public_id: batch.public_id,
        source_sha256: batch.archive_sha256, source_byte_size: batch.archive_byte_size,
      }));
      if (apply) {
        await client.query('BEGIN');
        try {
          const assets = snapshot.entries.filter(file => file.kind === 'image').map(file => {
            const absolute = resolve(root, ...file.storagePath.split('/'));
            const asset = (candidates.get(`${file.sha256}:${file.byteSize}`) ?? [])
              .find(candidate => resolve(candidate.storage_path).toLowerCase() === absolute.toLowerCase());
            assert.ok(asset, 'Snapshot image is not an available local asset');
            return { assetId: Number(asset.id), taskId: Number(asset.task_id), storagePath: absolute,
              sha256: file.sha256, byteSize: file.byteSize };
          });
          await registerDeliverySnapshotAssets(client, batch.public_id, assets);
          await saveDeliverySnapshot(root, snapshot);
          await inspectSnapshotSources(root, rows);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        if (removeArchives) {
          const metadata = await checkedPath(root, archivePath, { optional: true });
          if (metadata) {
            assert.ok(inside(root, archivePath) && metadata.isFile() && !metadata.isSymbolicLink());
            await rm(archivePath);
            result.removedFiles += 1; result.removedBytes += metadata.size;
          }
        }
      }
      result.snapshots += 1;
      onProgress({ batchId: Number(batch.id), processed: result.snapshots, total: batches.length, apply });
    } catch (error) {
      result.failures.push({ batchId: Number(batch.id), publicId: batch.public_id, error: String(error.message) });
      onProgress({ batchId: Number(batch.id), error: String(error.message) });
    }
  }
  if (removeArchives && result.failures.length === 0) {
    const jobs = (await client.query('SELECT id FROM delivery_archive_jobs')).rows;
    for (const job of jobs) {
      const directory = join(root, '.delivery-archives', String(Number(job.id)));
      assert.ok(Number.isSafeInteger(Number(job.id)) && Number(job.id) > 0 && inside(root, directory));
      if (!(await checkedPath(root, directory, { optional: true, directory: true }))) continue;
      const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return []; throw error;
      });
      for (const entry of entries) {
        if (!entry.isFile() || !/^[0-9a-f-]{36}-[1-9]\d*\.zip(?:\.tmp)?$/iu.test(entry.name)) continue;
        const path = join(directory, entry.name), metadata = await checkedPath(root, path);
        await rm(path); result.removedFiles += 1; result.removedBytes += metadata.size;
      }
    }
  }
  return result;
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.every(arg => /^--environment=(development|production)$/u.test(arg)
    || ['--apply', '--remove-archives'].includes(arg)), 'Use --environment=development|production [--apply] [--remove-archives]');
  const config = loadConfiguration({ args, environment: {} });
  const client = connectDatabase(config);
  try {
    await client.connect();
    const result = await migrateDeliverySnapshots(client, config.environment.CONTROL_PLANE_STORAGE_ROOT, {
      apply: args.includes('--apply'), removeArchives: args.includes('--remove-archives'),
      onProgress: progress => console.log(JSON.stringify({ profile: config.profile, ...progress })),
    });
    console.log(JSON.stringify({ profile: config.profile, result }));
    if (result.failures.length) process.exitCode = 1;
  } catch (error) { console.error(safeError(error, config)); process.exitCode = 1; }
  finally { await client.end(); }
}

if (isMain(import.meta.url)) await main();
