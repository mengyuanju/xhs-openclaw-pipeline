import { safeStoragePath } from './http-route-common.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export async function quarantineTaskStorage(storageRoot, taskId) {
  const quarantineRoot = safeStoragePath(storageRoot, '.task-deletion-quarantine', `${taskId}-${randomUUID()}`);
  const locations = [{
    source: safeStoragePath(storageRoot, 'tasks', String(taskId)),
    target: safeStoragePath(quarantineRoot, 'task')
  }, {
    source: safeStoragePath(storageRoot, 'thumbnails', String(taskId)),
    target: safeStoragePath(quarantineRoot, 'thumbnails')
  }, {
    source: safeStoragePath(storageRoot, 'image-edits', String(taskId)),
    target: safeStoragePath(quarantineRoot, 'image-edits')
  }];
  const moved = [];
  async function restoreMovedLocations() {
    const failures = [];
    for (const location of [...moved].reverse()) {
      try {
        await mkdir(dirname(location.source), {
          recursive: true
        });
        await rename(location.target, location.source);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to restore quarantined task files');
    }
    await rm(quarantineRoot, {
      recursive: true,
      force: true
    });
  }
  await mkdir(quarantineRoot, {
    recursive: true
  });
  try {
    for (const location of locations) {
      try {
        await rename(location.source, location.target);
        moved.push(location);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    try {
      await restoreMovedLocations();
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], 'failed to quarantine task files safely');
    }
    throw error;
  }
  return {
    quarantineRoot,
    async markCommitted() {
      await writeFile(safeStoragePath(quarantineRoot, 'COMMITTED'), new Date().toISOString(), {
        flag: 'wx'
      });
    },
    async restore() {
      await restoreMovedLocations();
    }
  };
}
export async function removeQuarantine(path, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(path, {
        recursive: true,
        force: true
      });
      return true;
    } catch {
      if (attempt === attempts) return false;
      await new Promise(resolvePromise => setTimeout(resolvePromise, attempt * 75));
    }
  }
  return false;
}
export function scheduleQuarantineCleanup(path, attempt = 1) {
  const timer = setTimeout(async () => {
    if (await removeQuarantine(path)) return;
    scheduleQuarantineCleanup(path, attempt + 1);
  }, Math.min(60_000, attempt * 5_000));
  timer.unref?.();
}
export async function cleanCommittedDeletionQuarantines(storageRoot) {
  const root = safeStoragePath(storageRoot, '.task-deletion-quarantine');
  let entries;
  try {
    entries = await readdir(root, {
      withFileTypes: true
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const directory = safeStoragePath(root, entry.name);
    try {
      await readFile(safeStoragePath(directory, 'COMMITTED'), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (!(await removeQuarantine(directory))) scheduleQuarantineCleanup(directory);
  }));
}
export async function applyBatchPermanentDeletion(repository, storageRoot, taskIds, actor, deletionPassword) {
  const quarantines = new Map();
  let result;
  try {
    result = await repository.permanentlyDeleteTasks(taskIds, {
      actor,
      deletionPassword,
      beforeDelete: async taskId => {
        quarantines.set(taskId, await quarantineTaskStorage(storageRoot, taskId));
      }
    });
  } catch (error) {
    for (const quarantine of [...quarantines.values()].reverse()) {
      try {
        await quarantine.restore();
      } catch (restoreError) {
        console.error('failed to restore quarantined task files', restoreError);
      }
    }
    throw error;
  }
  const cleanupPending = [];
  for (const taskId of result.succeeded) {
    const quarantine = quarantines.get(taskId);
    if (!quarantine) continue;
    await quarantine.markCommitted().catch(error => console.error('failed to mark task deletion quarantine', error));
    const cleaned = await removeQuarantine(quarantine.quarantineRoot);
    if (!cleaned) {
      cleanupPending.push(taskId);
      scheduleQuarantineCleanup(quarantine.quarantineRoot);
    }
  }
  return {
    action: 'PERMANENT_DELETE',
    succeeded: result.succeeded,
    failed: result.failed,
    cleanupPending
  };
}
