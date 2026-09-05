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

function terminateTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => { child.kill(); resolve(); });
    killer.once('close', resolve);
  });
}

export function runCodexProcess(command, args, {
  input = '', cwd, env, timeoutMs = 180_000, signal, onSpawn, maxBuffer = 32 * 1024 * 1024,
} = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    let size = 0; let failure; let termination;
    function stop(error) {
      if (failure) return;
      failure = error;
      termination = terminateTree(child);
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
    child.once('error', (error) => { failure ??= error; });
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') stop(error); });
    child.once('close', async (status) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      await termination;
      resolve({ status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), error: failure });
    });
    child.stdin.end(input);
  });
}
