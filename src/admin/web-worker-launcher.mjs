import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const MAX_WEB_WORKER_TASKS = 20;
const MAX_TASK_CONCURRENCY = 2;
const DEFAULT_PROJECT_ROOT = process.cwd();
const DEFAULT_CLI_PATH = join(DEFAULT_PROJECT_ROOT, 'src', 'cli.mjs');

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

function validatedConcurrency(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TASK_CONCURRENCY) {
    throw new RangeError(`worker concurrency must be between 1 and ${MAX_TASK_CONCURRENCY}`);
  }
  return value;
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
    async start({ max: rawMax, concurrency: rawConcurrency = MAX_TASK_CONCURRENCY }) {
      const max = validatedMax(rawMax);
      const concurrency = validatedConcurrency(rawConcurrency);
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
          '--concurrency',
          String(concurrency),
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
      return { status: 'STARTED', runId, max, concurrency };
    },
  };
}

export const webWorkerLauncher = createWebWorkerLauncher();
export { MAX_TASK_CONCURRENCY, MAX_WEB_WORKER_TASKS };
