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

async function findPostgresBin() {
  for (const candidate of POSTGRES_BIN_CANDIDATES) {
    try {
      await access(join(candidate, executableName('initdb')));
      await access(join(candidate, executableName('pg_ctl')));
      return candidate;
    } catch {
      // Continue to the next explicit PostgreSQL 18 installation location.
    }
  }
  throw new Error(
    'PostgreSQL 18 tools were not found; set POSTGRES_E2E_BIN to the directory containing initdb and pg_ctl.',
  );
}

async function runTool(file, args, options = {}) {
  try {
    return await execFile(file, args, {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const detail = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join('\n');
    throw new Error(`PostgreSQL test tool failed: ${detail}`, { cause: error });
  }
}

async function runPgControl(file, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`PostgreSQL control command timed out: ${args.at(-1)}`));
    }, 60_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`PostgreSQL control command failed with code ${code} and signal ${signal ?? 'none'}.`));
    });
  });
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!Number.isSafeInteger(port)) throw new Error('Could not reserve an isolated PostgreSQL port.');
  return port;
}

export async function startTemporaryPostgres18() {
  const postgresBin = await findPostgresBin();
  const initdb = join(postgresBin, executableName('initdb'));
  const pgCtl = join(postgresBin, executableName('pg_ctl'));
  const version = await runTool(initdb, ['--version']);
  assert.match(`${version.stdout}${version.stderr}`, /\b18\.\d+\b/u, 'the E2E test must use PostgreSQL 18');

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'xhs-personal-workspace-pg18-'));
  const dataDirectory = join(temporaryRoot, 'data');
  const logFile = join(temporaryRoot, 'postgres.log');
  const port = await reserveLoopbackPort();
  let started = false;
  try {
    await runTool(initdb, [
      '-D', dataDirectory,
      '-A', 'trust',
      '-U', 'postgres',
      '--encoding=UTF8',
      '--locale=C',
      '--no-sync',
    ]);
    await runPgControl(pgCtl, [
      '-D', dataDirectory,
      '-l', logFile,
      '-o', `-h 127.0.0.1 -p ${port}`,
      '-w',
      'start',
    ]);
    started = true;
    return {
      connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`,
      async stop() {
        if (started) {
          await runPgControl(pgCtl, ['-D', dataDirectory, '-m', 'fast', '-w', 'stop']);
          started = false;
        }
        assert.ok(temporaryRoot.startsWith(join(tmpdir(), 'xhs-personal-workspace-pg18-')));
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      },
    };
  } catch (error) {
    if (started) {
      await runPgControl(pgCtl, ['-D', dataDirectory, '-m', 'immediate', '-w', 'stop']).catch(() => {});
    }
    assert.ok(temporaryRoot.startsWith(join(tmpdir(), 'xhs-personal-workspace-pg18-')));
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      .catch(() => {});
    throw error;
  }
}
