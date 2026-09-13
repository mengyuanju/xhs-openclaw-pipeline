import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { codexConcurrencyConfig, codexRuntimePath } from '../codex-runtime.mjs';

export function executorConcurrency(value, name) {
  if (value === undefined) return 1;
  if (!/^[0-9]+$/u.test(String(value)) || !Number.isInteger(Number(value))
    || Number(value) < 1 || Number(value) > 32) {
    throw new RangeError(`${name} must be an integer from 1 to 32`);
  }
  return Number(value);
}

export function codexPoolIdentity(environment = process.env) {
  const explicit = environment.XHS_CODEX_POOL_ID?.trim();
  if (explicit !== undefined) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(explicit)) {
      throw new TypeError('XHS_CODEX_POOL_ID must contain 1 to 128 safe identifier characters');
    }
    return explicit;
  }
  const identity = `${hostname().toLowerCase()}\0${resolve(codexRuntimePath(environment)).toLowerCase()}`;
  return `codex-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

export function executorConfig(environment = process.env, args = process.argv.slice(2), { simulation = false } = {}) {
  const option = (name) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const hasFlag = (name) => args.includes(`--${name}`);
  const serverUrl = option('server-url') ?? environment.CONTROL_PLANE_URL;
  const baseNodeId = environment.EXECUTOR_NODE_ID?.trim() || 'local';
  const nodeId = (option('node-id') ?? (simulation
    ? environment.DEEPSEEK_SIM_NODE_ID ?? `${baseNodeId.slice(0, 50)}-deepseek-sim`
    : environment.EXECUTOR_NODE_ID))?.trim();
  const nodeName = option('node-name') ?? (simulation
    ? environment.DEEPSEEK_SIM_NODE_NAME ?? `${nodeId}（DeepSeek 模拟）`
    : environment.EXECUTOR_NODE_NAME ?? nodeId);
  if (!serverUrl) throw new Error('CONTROL_PLANE_URL or --server-url is required');
  if (!nodeId) throw new Error('EXECUTOR_NODE_ID or --node-id is required');
  const pollMs = Number(option('poll-ms') ?? environment.EXECUTOR_POLL_MS ?? 5000);
  if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 60000) {
    throw new RangeError('poll interval must be an integer from 1000 to 60000 milliseconds');
  }
  if (hasFlag('enable-image-worker') && hasFlag('disable-image-worker')) {
    throw new Error('--enable-image-worker and --disable-image-worker cannot be used together');
  }
  let imageWorkerEnabled = false;
  if (hasFlag('enable-image-worker')) imageWorkerEnabled = true;
  else if (!hasFlag('disable-image-worker') && environment.IMAGE_WORKER_ENABLED !== undefined) {
    if (!['true', 'false'].includes(environment.IMAGE_WORKER_ENABLED)) {
      throw new TypeError('IMAGE_WORKER_ENABLED must be true or false');
    }
    imageWorkerEnabled = environment.IMAGE_WORKER_ENABLED === 'true';
  }
  const codexCapacity = codexConcurrencyConfig(environment);
  return {
    serverUrl, nodeId, nodeName, pollMs, imageWorkerEnabled,
    codexPoolId: codexPoolIdentity(environment),
    codexTotalConcurrency: codexCapacity.maxConcurrent,
    codexImageConcurrency: codexCapacity.maxConcurrentImages,
    copyConcurrency: executorConcurrency(environment.EXECUTOR_COPY_CONCURRENCY, 'EXECUTOR_COPY_CONCURRENCY'),
    imageConcurrency: executorConcurrency(environment.EXECUTOR_IMAGE_CONCURRENCY, 'EXECUTOR_IMAGE_CONCURRENCY'),
    once: hasFlag('once'), workRoot: resolve(environment.EXECUTOR_WORK_ROOT || 'data/executor-work'),
  };
}
