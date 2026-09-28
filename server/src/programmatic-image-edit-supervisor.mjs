import { fork } from 'node:child_process';
import { normalizeUuid } from './domain.mjs';
import { programmaticConcurrency, safeProgrammaticLog } from './programmatic-image-edit-runner.mjs';

export const PROGRAMMATIC_IMAGE_EDIT_CHANNEL = 'programmatic_image_edits';

export async function notifyProgrammaticImageEdits(pool, editIds) {
  if (!Array.isArray(editIds) || editIds.length > 500) throw new TypeError('invalid programmatic edit notification');
  const ids = [...new Set(editIds.map(id => normalizeUuid(id, 'editId')))];
  // PostgreSQL notification payloads must be shorter than 8000 bytes.
  for (let offset = 0; offset < ids.length; offset += 150) {
    await pool.query('SELECT pg_notify($1, $2)', [PROGRAMMATIC_IMAGE_EDIT_CHANNEL, JSON.stringify(ids.slice(offset, offset + 150))]);
  }
}

export function startProgrammaticImageEditProcess({ connectionString, storageRoot }, {
  concurrency = 2,
  environment = process.env,
  forkProcess = fork,
  log = console,
  restartDelayMs = 1000,
  shutdownTimeoutMs = 30_000,
} = {}) {
  concurrency = programmaticConcurrency(concurrency);
  if (!connectionString || !storageRoot) throw new TypeError('database and storage are required');
  let child = null, ready = false, stopped = false, restartTimer = null, stopping = null;
  const pending = new Set();
  function flush() {
    if (!ready || !child?.connected || !pending.size || stopped) return;
    const ids = [...pending].slice(0, 500);
    for (const id of ids) pending.delete(id);
    try {
      child.send({ type: 'wake', editIds: ids }, error => {
        if (error) {
          for (const id of ids) pending.add(id);
          safeProgrammaticLog(log, 'error', `Programmatic worker notification failed: ${error.message}`);
        } else flush();
      });
    } catch (error) {
      for (const id of ids) pending.add(id);
      safeProgrammaticLog(log, 'error', `Programmatic worker notification failed: ${error.message}`);
    }
  }
  function start() {
    if (stopped) return;
    try {
      child = forkProcess(new URL('./programmatic-image-edit-process.mjs', import.meta.url), [], {
        silent: true, windowsHide: true, shell: false, execArgv: [],
        env: { ...environment, DATABASE_URL: connectionString, CONTROL_PLANE_STORAGE_ROOT: storageRoot,
          PROGRAMMATIC_IMAGE_CONCURRENCY: String(concurrency) },
      });
    } catch (error) {
      safeProgrammaticLog(log, 'error', `Programmatic worker startup failed: ${error.message}`);
      restartTimer = setTimeout(start, restartDelayMs);
      restartTimer.unref();
      return;
    }
    const spawned = child;
    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      if (child === spawned) child = null;
      ready = false;
      if (!stopped) {
        safeProgrammaticLog(log, 'error', 'Programmatic image edit worker exited; restarting.');
        restartTimer = setTimeout(start, restartDelayMs);
        restartTimer.unref();
      }
    }
    ready = false;
    spawned.stdout?.on('data', data => safeProgrammaticLog(log, 'log', data.toString().trim()));
    spawned.stderr?.on('data', data => safeProgrammaticLog(log, 'error', data.toString().trim()));
    spawned.on('error', error => {
      safeProgrammaticLog(log, 'error', `Programmatic worker failed: ${error.message}`);
      if (spawned.pid == null) finish();
      else spawned.kill();
    });
    spawned.on('message', message => {
      if (finished || child !== spawned) return;
      if (message?.type === 'ready') {
        ready = true;
        safeProgrammaticLog(log, 'log', `Programmatic image edit worker is ready (concurrency ${concurrency}).`);
        flush();
      }
    });
    spawned.once('exit', finish);
    spawned.once('close', finish);
  }
  start();
  function wake(editIds = []) {
    if (stopped) return false;
    if (!Array.isArray(editIds) || editIds.length > 500) throw new TypeError('invalid programmatic edit notification');
    for (const id of editIds) pending.add(normalizeUuid(id, 'editId'));
    flush();
    return true;
  }
  function stop() {
    if (stopping) return stopping;
    stopped = true;
    clearTimeout(restartTimer);
    const current = child;
    stopping = current ? new Promise(resolve => {
      let settled = false;
      const timeout = setTimeout(() => { current.kill(); }, shutdownTimeoutMs);
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      current.once('exit', finish);
      current.once('close', finish);
      if (typeof current.exitCode === 'number' || current.signalCode) return finish();
      if (current.connected) {
        try { current.send({ type: 'stop' }, error => { if (error) current.kill(); }); }
        catch { current.kill(); }
      } else current.kill();
    }) : Promise.resolve();
    return stopping;
  }
  return { wake, stop };
}
