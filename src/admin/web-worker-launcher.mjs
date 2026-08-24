import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAX_WEB_WORKER_TASKS = 20;
const DEFAULT_CLI_PATH = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export class WorkerRunConflictError extends Error {
  constructor(message = '已有网页 Worker 正在运行') {
    super(message);
    this.name = 'WorkerRunConflictError';
  }
}

function validatedMax(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_WEB_WORKER_TASKS) {
    throw new RangeError(`worker max must be between 1 and ${MAX_WEB_WORKER_TASKS}`);
  }
  return value;
}

function validatedRunId(value) {
  const runId = String(value ?? '');
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(runId)) throw new TypeError('worker run id is invalid');
  return runId;
}

export function createWebWorkerLauncher({
  spawnProcess = spawn,
  nodePath = process.execPath,
  cliPath = DEFAULT_CLI_PATH,
  projectRoot = DEFAULT_PROJECT_ROOT,
  createRunId = randomUUID,
} = {}) {
  let activeProcess = null;

  return {
    async start({ max: rawMax }) {
      const max = validatedMax(rawMax);
      if (activeProcess?.exitCode === null) throw new WorkerRunConflictError();
      const runId = validatedRunId(createRunId());
      const child = spawnProcess(
        nodePath,
        [
          cliPath,
          'drain',
          '--live',
          '--max',
          String(max),
          '--worker-id',
          `web-${runId}`,
        ],
        {
          cwd: projectRoot,
          detached: true,
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      activeProcess = child;
      child.once('exit', () => {
        if (activeProcess === child) activeProcess = null;
      });
      try {
        await new Promise((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
      } catch (error) {
        if (activeProcess === child) activeProcess = null;
        throw error;
      }
      child.unref();
      return { status: 'STARTED', runId, max };
    },
  };
}

export const webWorkerLauncher = createWebWorkerLauncher();
export { MAX_WEB_WORKER_TASKS };
