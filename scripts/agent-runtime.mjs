import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkCodexLogin, codexChildEnvironment, resolveCodexExecutable } from '../src/codex-process.mjs';
import { codexRuntimePath, createCodexRuntime } from '../src/codex-runtime.mjs';

// Diagnostics never start a model turn. Resume clears only our local pause;
// it cannot renew subscription quota or requeue a failed business task.
export function main(args = process.argv.slice(2), { environment = process.env, runner = spawnSync,
  runtime, executable, stdout = process.stdout } = {}) {
  const [action = 'status'] = args;
  if (args.length > 1 || !['check', 'status', 'resume'].includes(action)) throw new TypeError('expected check, status or resume');
  const limits = runtime ?? createCodexRuntime({ databasePath: codexRuntimePath(environment) });
  let login; let version;
  if (action !== 'status') {
    const command = executable ?? resolveCodexExecutable(environment);
    login = checkCodexLogin({ environment, executable: command, runner });
    const result = runner(command, ['--version'], { shell: false, windowsHide: true, encoding: 'utf8',
      timeout: 15_000, env: codexChildEnvironment(environment), maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error('Codex CLI version check failed');
    version = String(result.stdout).trim();
    if (action === 'resume') limits.reset();
  }
  const result = { action, ...login, version, runtime: limits.status(),
    imageCapability: 'requires-live-verification',
    ...(action === 'resume' ? { note: '仅清除本机暂停；不补充额度。失败任务仍需在后台人工续跑。' } : {}) };
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
