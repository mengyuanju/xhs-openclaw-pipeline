import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const POSTGRES_BIN_CANDIDATES = Object.freeze([
  process.env.POSTGRES_E2E_BIN,
  process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\18\\bin' : null,
  process.platform === 'linux' ? '/usr/lib/postgresql/18/bin' : null,
  process.platform === 'darwin' ? '/opt/homebrew/opt/postgresql@18/bin' : null,
].filter(Boolean));

function executableName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

async function postgresBin() {
  for (const candidate of POSTGRES_BIN_CANDIDATES) {
    try {
      await access(join(candidate, executableName('initdb')));
      await access(join(candidate, executableName('pg_ctl')));
      return candidate;
    } catch {
      // Try the next supported installation path.
    }
  }
  throw new Error('PostgreSQL 18 tools were not found; set POSTGRES_E2E_BIN.');
}

async function runTool(file, args) {
  return execFile(file, args, {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function runControl(file, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('PostgreSQL control command timed out'));
    }, 60_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`PostgreSQL control command failed with code ${code} and signal ${signal ?? 'none'}`));
    });
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!Number.isSafeInteger(port)) throw new Error('Could not reserve a PostgreSQL test port.');
  return port;
}

export async function startTemporaryPostgres18(prefix = 'xhs-pg18-') {
  const bin = await postgresBin();
  const initdb = join(bin, executableName('initdb'));
  const pgCtl = join(bin, executableName('pg_ctl'));
  const version = await runTool(initdb, ['--version']);
  assert.match(`${version.stdout}${version.stderr}`, /\b18\.\d+\b/u);
  const root = await mkdtemp(join(tmpdir(), prefix));
  const data = join(root, 'data');
  const log = join(root, 'postgres.log');
  const port = await reservePort();
  let started = false;
  try {
    await runTool(initdb, ['-D', data, '-A', 'trust', '-U', 'postgres', '--encoding=UTF8', '--locale=C', '--no-sync']);
    await runControl(pgCtl, ['-D', data, '-l', log, '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
    started = true;
    return {
      connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`,
      async stop() {
        if (started) {
          await runControl(pgCtl, ['-D', data, '-m', 'fast', '-w', 'stop']);
          started = false;
        }
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      },
    };
  } catch (error) {
    if (started) await runControl(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop']).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    throw error;
  }
}
