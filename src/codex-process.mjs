import { spawn, spawnSync } from 'node:child_process';
import { codexFailure } from './codex-protocol.mjs';
import { existsSync } from 'node:fs';
import { join, delimiter, isAbsolute } from 'node:path';

const ENV_KEYS = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE',
  'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
  'CODEX_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);

export function codexChildEnvironment(environment = process.env, proxyUrl) {
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => ENV_KEYS.has(key.toUpperCase())));
  if (proxyUrl) Object.assign(env, { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl });
  return env;
}

export function resolveCodexExecutable(environment = process.env) {
  if (environment.XHS_CODEX_BIN) {
    const path = environment.XHS_CODEX_BIN;
    if (!isAbsolute(path) || !existsSync(path) || (process.platform === 'win32' && !path.toLowerCase().endsWith('.exe'))) {
      throw new TypeError('XHS_CODEX_BIN must be an absolute native Codex executable path (Windows: .exe)');
    }
    return path;
  }
  const candidates = [];
  if (process.platform === 'win32') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const target = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    if (environment.APPDATA) candidates.push(join(environment.APPDATA, 'npm', 'node_modules', '@openai', 'codex',
      'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', target, 'bin', 'codex.exe'));
    if (environment.LOCALAPPDATA) candidates.push(join(environment.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
  }
  const pathValue = Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    candidates.push(join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  }
  const found = candidates.find((path) => isAbsolute(path) && existsSync(path));
  if (!found) throw new Error('Codex executable not found; install Codex CLI or set XHS_CODEX_BIN to its native executable');
  return found;
}

export function checkCodexLogin({ environment = process.env, executable, runner = spawnSync, timeoutMs = 15_000 } = {}) {
  const command = executable ?? resolveCodexExecutable(environment);
  const result = runner(command, ['-c', 'forced_login_method="chatgpt"', 'login', 'status'],
    { shell: false, windowsHide: true, encoding: 'utf8', timeout: timeoutMs, env: codexChildEnvironment(environment), maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0 || !/logged in using ChatGPT/iu.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) {
    throw codexFailure({ code: 'authentication_required', message: 'codex login status must report ChatGPT authentication' });
  }
  return { authentication: 'chatgpt' };
}

export function terminateCodexTree(child, { spawnImpl = spawn, timeoutMs = 5000 } = {}) {
  if (!child.pid) return Promise.resolve();
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawnImpl(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    const fallback = () => { try { child.kill(); } catch { /* The runtime retains any surviving PID. */ } };
    const timer = setTimeout(() => {
      fallback();
      try { killer.kill(); } catch { /* Do not block the executor on a stuck OS helper. */ }
      killer.unref();
      resolve();
    }, timeoutMs);
    killer.once('error', () => { clearTimeout(timer); fallback(); resolve(); });
    killer.once('close', (status) => {
      clearTimeout(timer);
      if (status !== 0) fallback();
      resolve();
    });
  });
}

export function runCodexProcess(command, args, {
  input = '', cwd, env, timeoutMs = 180_000, signal, onSpawn, maxBuffer = 32 * 1024 * 1024,
  shutdownGraceMs = 5_000, spawnImpl = spawn, terminate = terminateCodexTree,
} = {}) {
  signal?.throwIfAborted();
  if (!Number.isFinite(shutdownGraceMs) || shutdownGraceMs < 1) throw new RangeError('shutdownGraceMs must be positive');
  return new Promise((resolve) => {
    const child = spawnImpl(command, args, { cwd, env, windowsHide: true, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    let size = 0; let failure; let termination; let shutdownTimer; let settled = false;
    function finish(status, terminationConfirmed) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(shutdownTimer);
      signal?.removeEventListener('abort', aborted);
      if (!terminationConfirmed) {
        // A stuck child/pipe or taskkill must not hold the task forever. The shared
        // runtime retains the child's permit until its PID has actually exited.
        child.unref();
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      }
      resolve({ status, stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'), error: failure, terminationConfirmed });
    }
    function stop(error) {
      if (settled || termination) return;
      failure = error;
      shutdownTimer = setTimeout(() => finish(null, false), shutdownGraceMs);
      termination = Promise.resolve().then(() => terminate(child)).catch(() => {});
    }
    const aborted = () => stop(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    const timer = setTimeout(() => stop(Object.assign(new Error('Codex execution timed out; generation outcome may be unknown'),
      { code: 'CODEX_EXEC_TIMEOUT' })), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    child.once('spawn', () => {
      try { onSpawn?.(child.pid); if (signal?.aborted) aborted(); }
      catch (error) { stop(error); }
    });
    function collect(target, chunk) {
      size += chunk.length;
      if (size > maxBuffer) stop(Object.assign(new Error('Codex output exceeds buffer limit'), { code: 'CODEX_OUTPUT_TOO_LARGE' }));
      else target.push(chunk);
    }
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.once('error', (error) => { stop(error); });
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') stop(error); });
    child.once('close', async (status) => {
      // Stop the execution deadline once close is observed. Cleanup itself still
      // has the bounded shutdown timer if the tree terminator never returns.
      clearTimeout(timer);
      await termination;
      finish(status, true);
    });
    child.stdin.end(input);
  });
}
