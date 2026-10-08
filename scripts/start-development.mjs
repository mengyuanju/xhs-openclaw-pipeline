#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadServerEnvironment } from '../server/src/server-environment.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const HOST = '127.0.0.1';
const CONTROL_PLANE_HOST = '0.0.0.0';
const CONTROL_PLANE_PORT = 4311;
const WEB_PORT = 3002;
const DEV_DIST_DIR = '.next-dev-4311';
const SAFE_EXTERNAL_ENV = Object.freeze({
  PREVIEW_BASE_URL: ' ',
  PREVIEW_API_KEY: ' ',
  DEEPSEEK_API_KEY: ' ',
  XHS_DOTS_API_KEY: ' ',
  XHS_SEARCH_MACHINE_TOKEN: ' ',
});

class LauncherError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LauncherError';
  }
}

export function parseArguments(argv) {
  if (argv.length === 0) return { checkOnly: false };
  if (argv.length === 1 && argv[0] === '--check-only') return { checkOnly: true };
  throw new LauncherError('Usage: node scripts/start-development.mjs [--check-only]');
}

function normalizedHost(hostname) {
  const host = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  return ['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1'].includes(host)
    ? 'loopback' : host;
}

export function databaseIdentity(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new LauncherError('A database URL is missing or invalid.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new LauncherError('Database URLs must use PostgreSQL and include a host.');
  }
  // These parameters can override the URI authority or database in libpq-style URLs.
  for (const key of ['host', 'hostaddr', 'port', 'dbname', 'database', 'service', 'servicefile']) {
    if (url.searchParams.has(key)) {
      throw new LauncherError('Database URLs with connection-target query overrides are unsupported.');
    }
  }
  let database;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new LauncherError('A database name is missing or invalid.');
  }
  if (!database || database.includes('/')) {
    throw new LauncherError('A database URL must contain one database name.');
  }
  const port = Number(url.port || 5432);
  return { host: normalizedHost(url.hostname), port, database };
}

function sameDatabase(left, right) {
  return left.host === right.host && left.port === right.port && left.database === right.database;
}

function comparisonPath(path) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function canonicalStoragePath(path, cwd = process.cwd()) {
  if (typeof path !== 'string' || !path.trim()) {
    throw new LauncherError('A storage directory is missing.');
  }
  const absolute = resolve(cwd, path);
  const root = parse(absolute).root;
  let existing = root;
  try {
    if (lstatSync(root).isSymbolicLink()) {
      throw new LauncherError('A storage path contains a symbolic link or junction.');
    }
    for (const segment of relative(root, absolute).split(sep).filter(Boolean)) {
      const candidate = join(existing, segment);
      let stat;
      try {
        stat = lstatSync(candidate);
      } catch (error) {
        if (error?.code === 'ENOENT') break;
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new LauncherError('A storage path contains a symbolic link or junction.');
      }
      if (!stat.isDirectory()) {
        throw new LauncherError('A storage path contains a non-directory component.');
      }
      existing = candidate;
    }
    return resolve(realpathSync.native(existing), relative(existing, absolute));
  } catch (error) {
    if (error instanceof LauncherError) throw error;
    throw new LauncherError('A storage path could not be inspected.');
  }
}

function containsPath(parent, child) {
  const difference = relative(comparisonPath(parent), comparisonPath(child));
  return difference === '' || (difference !== '..' && !difference.startsWith(`..${sep}`)
    && !isAbsolute(difference));
}

export function assertStorageSeparated(developmentPath, productionPath, {
  cwd = process.cwd(), label = 'Storage directories',
} = {}) {
  const development = canonicalStoragePath(developmentPath, cwd);
  const production = canonicalStoragePath(productionPath, cwd);
  if (containsPath(development, production) || containsPath(production, development)) {
    throw new LauncherError(`${label} must be separate and cannot contain each other.`);
  }
  return { development, production };
}

export function inspectDevelopmentConfiguration({
  environment = process.env, projectRoot = PROJECT_ROOT,
} = {}) {
  const root = resolve(projectRoot);
  const serverRoot = join(root, 'server');
  const inherited = { ...environment };
  // A caller's shell can be configured for production; the server profiles own these paths.
  delete inherited.DATABASE_URL;
  delete inherited.CONTROL_PLANE_STORAGE_ROOT;

  let development, production;
  try {
    development = loadServerEnvironment({
      args: ['--environment=development'], environment: inherited, serverRoot,
    });
    production = loadServerEnvironment({
      args: ['--environment=production'], environment: inherited, serverRoot,
    });
  } catch {
    throw new LauncherError('Development and production server profiles must both be configured.');
  }
  const devDatabase = databaseIdentity(development.environment.DATABASE_URL);
  const prodDatabase = databaseIdentity(production.environment.DATABASE_URL);
  if (sameDatabase(devDatabase, prodDatabase)) {
    throw new LauncherError('Development and production profiles resolve to the same database.');
  }

  const storage = assertStorageSeparated(
    development.environment.CONTROL_PLANE_STORAGE_ROOT || 'server-storage',
    production.environment.CONTROL_PLANE_STORAGE_ROOT || 'server-storage',
    { cwd: serverRoot, label: 'Control-plane storage directories' },
  );
  const build = assertStorageSeparated(DEV_DIST_DIR, '.next', {
    cwd: root, label: 'Next build directories',
  });

  const controlPlaneUrl = `http://${HOST}:${CONTROL_PLANE_PORT}`;
  const webUrl = `http://${HOST}:${WEB_PORT}`;
  const controlPlaneEnvironment = {
    ...development.environment,
    XHS_SERVER_ENV: 'development',
    DATABASE_URL: development.environment.DATABASE_URL,
    CONTROL_PLANE_URL: controlPlaneUrl,
    CONTROL_PLANE_HOST,
    CONTROL_PLANE_PORT: String(CONTROL_PLANE_PORT),
    CONTROL_PLANE_STORAGE_ROOT: storage.development,
    PROGRAMMATIC_IMAGE_WORKER_MODE: 'external',
    ...SAFE_EXTERNAL_ENV,
  };
  const webEnvironment = {
    ...inherited,
    NODE_ENV: 'development',
    XHS_SERVER_ENV: 'development',
    CONTROL_PLANE_URL: controlPlaneUrl,
    EXECUTOR_NODE_ID: 'dev-web-test',
    XHS_NEXT_DIST_DIR: DEV_DIST_DIR,
    ...SAFE_EXTERNAL_ENV,
  };
  const safeConfig = {
    environment: 'development',
    controlPlane: {
      url: controlPlaneUrl,
      listenHost: CONTROL_PLANE_HOST,
      database: `${devDatabase.host}:${devDatabase.port}/${devDatabase.database}`,
      storageRoot: storage.development,
      programmaticImageWorker: 'external',
    },
    productionGuard: {
      database: `${prodDatabase.host}:${prodDatabase.port}/${prodDatabase.database}`,
      storageRoot: storage.production,
    },
    web: { url: webUrl, distDir: DEV_DIST_DIR, distPath: build.development },
  };
  return { root, serverRoot, controlPlaneEnvironment, webEnvironment, safeConfig };
}

export async function assertPortAvailable(port, host = HOST) {
  const server = createServer();
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen({ host, port, exclusive: true }, resolvePromise);
    });
  } catch {
    throw new LauncherError(`Port ${port} on ${host} is unavailable.`);
  } finally {
    if (server.listening) await new Promise(resolvePromise => server.close(resolvePromise));
  }
}

function launchNode(name, args, { cwd, env, spawnImpl }) {
  let child;
  try {
    child = spawnImpl(process.execPath, args, {
      cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
  } catch {
    throw new LauncherError(`${name} could not be started.`);
  }
  const state = { name, child, outcome: null, finished: null };
  state.finished = new Promise(resolvePromise => {
    const finish = outcome => {
      if (state.outcome) return;
      state.outcome = { name, ...outcome };
      resolvePromise(state.outcome);
    };
    child.once('error', () => finish({ kind: 'error' }));
    child.once('exit', (code, signal) => finish({ kind: 'exit', code, signal }));
  });
  return state;
}

function delay(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

export async function waitForControlPlaneHealth(state, {
  fetchImpl = fetch, delayImpl = delay, signal, timeoutMs = 90_000,
  url = `http://${HOST}:${CONTROL_PLANE_PORT}/health`,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let onAbort;
  const interrupted = new Promise(resolvePromise => {
    onAbort = () => resolvePromise(false);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new LauncherError('Development startup was interrupted.');
      if (state.outcome) throw new LauncherError('Development control plane exited before it was healthy.');
      const probeController = new AbortController();
      let probeTimer;
      const timedOut = new Promise(resolvePromise => {
        probeTimer = setTimeout(() => {
          probeController.abort();
          resolvePromise(false);
        }, Math.min(1500, Math.max(1, deadline - Date.now())));
      });
      const probe = (async () => {
        try {
          const response = await fetchImpl(url, { signal: probeController.signal });
          if (!response.ok) return false;
          const health = await response.json();
          return health?.data?.ok === true
            && health.data.xhsSearchMachineTokenConfigured === false;
        } catch {
          // A connection refusal is expected until the control plane starts listening.
          return false;
        }
      })();
      const ready = await Promise.race([probe, state.finished, interrupted, timedOut]);
      clearTimeout(probeTimer);
      probeController.abort();
      if (ready === true && !state.outcome && !signal?.aborted) return;
      await Promise.race([delayImpl(300), state.finished, interrupted]);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  throw new LauncherError('Development control plane did not become healthy in time.');
}

export async function terminateProcessTree(state) {
  const pid = state?.child?.pid;
  if (!Number.isInteger(pid) || pid < 1) return;
  if (process.platform === 'win32') {
    await new Promise(resolvePromise => {
      let killer;
      try {
        killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(pid), '/T', '/F'],
          { shell: false, windowsHide: true, stdio: 'ignore' });
      } catch {
        try { state.child.kill(); } catch { /* Already stopped. */ }
        resolvePromise();
        return;
      }
      const timer = setTimeout(() => {
        try { killer.kill(); } catch { /* Already stopped. */ }
        try { state.child.kill(); } catch { /* Already stopped. */ }
        resolvePromise();
      }, 5000);
      killer.once('error', () => {
        clearTimeout(timer);
        try { state.child.kill(); } catch { /* Already stopped. */ }
        resolvePromise();
      });
      killer.once('close', code => {
        clearTimeout(timer);
        if (code !== 0) {
          try { state.child.kill(); } catch { /* Already stopped. */ }
        }
        resolvePromise();
      });
    });
    return;
  }
  try { state.child.kill('SIGTERM'); } catch { /* Already stopped. */ }
  await Promise.race([state.finished, delay(2000)]);
  if (!state.outcome) {
    try { state.child.kill('SIGKILL'); } catch { /* Already stopped. */ }
  }
}

export async function main(argv = process.argv.slice(2), {
  environment = process.env,
  projectRoot = PROJECT_ROOT,
  spawnImpl = spawn,
  fetchImpl = fetch,
  checkPortImpl = assertPortAvailable,
  terminateTreeImpl = terminateProcessTree,
  log = console.log,
  signals = process,
  delayImpl = delay,
} = {}) {
  const options = parseArguments(argv);
  const config = inspectDevelopmentConfiguration({ environment, projectRoot });
  for (const [port, host] of [[CONTROL_PLANE_PORT, CONTROL_PLANE_HOST], [WEB_PORT, HOST]]) {
    try {
      await checkPortImpl(port, host);
    } catch {
      throw new LauncherError(
        `端口 ${port}（${host}）已被占用，本次未启动新服务。\n`
        + `如果开发服务已启动，请直接打开 ${config.safeConfig.web.url}；中心地址为 ${config.safeConfig.controlPlane.url}。\n`
        + '如需重新启动，请先关闭占用端口的旧服务；开发中心使用 4311，生产中心保留 4310。',
      );
    }
  }
  if (options.checkOnly) {
    log(JSON.stringify(config.safeConfig, null, 2));
    return { checkOnly: true, config: config.safeConfig };
  }

  const nextBin = join(config.root, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBin)) throw new LauncherError('Next.js is not installed in this project.');
  const children = [];
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  signals.on('SIGINT', interrupt);
  signals.on('SIGTERM', interrupt);
  try {
    const controlPlane = launchNode('Development control plane', [
      join(config.serverRoot, 'src', 'cli.mjs'), 'serve', '--environment=development',
    ], {
      cwd: config.serverRoot,
      env: config.controlPlaneEnvironment,
      spawnImpl,
    });
    children.push(controlPlane);
    await waitForControlPlaneHealth(controlPlane, {
      fetchImpl, delayImpl, signal: controller.signal,
    });
    if (controller.signal.aborted || controlPlane.outcome) {
      throw new LauncherError('Development startup was interrupted.');
    }

    const web = launchNode('Development web', [
      nextBin, 'dev', '-H', HOST, '-p', String(WEB_PORT),
    ], {
      cwd: config.root,
      env: {
        ...config.webEnvironment,
        XHS_SESSION_SECRET: randomBytes(32).toString('hex'),
      },
      spawnImpl,
    });
    children.push(web);
    log(`Development control plane: http://${HOST}:${CONTROL_PLANE_PORT} (listening on ${CONTROL_PLANE_HOST})`);
    log(`Development web: http://${HOST}:${WEB_PORT} (use a private browser window)`);

    const interrupted = new Promise(resolvePromise => {
      if (controller.signal.aborted) resolvePromise({ interrupted: true });
      else controller.signal.addEventListener('abort',
        () => resolvePromise({ interrupted: true }), { once: true });
    });
    const outcome = await Promise.race([controlPlane.finished, web.finished, interrupted]);
    if (!outcome.interrupted) {
      throw new LauncherError(`${outcome.name} stopped unexpectedly.`);
    }
    return { stopped: true };
  } catch (error) {
    if (controller.signal.aborted) return { stopped: true };
    throw error;
  } finally {
    await Promise.all(children.map(state => terminateTreeImpl(state)));
    signals.off('SIGINT', interrupt);
    signals.off('SIGTERM', interrupt);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch(error => {
    console.error(error instanceof LauncherError ? error.message : 'Development launcher failed.');
    process.exitCode = 1;
  });
}
