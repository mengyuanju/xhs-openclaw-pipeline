import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withPromptRuntime } from '../prompt-runtime.mjs';
import { safeTraceText, withModelCallTracing } from '../model-call-trace.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function redacted(value) {
  if (typeof value === 'string') return safeTraceText(value).text;
  if (Array.isArray(value)) return value.map(redacted);
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redacted(item)])) : value;
}
function pathFor(root, id) {
  if (!uuid.test(id)) throw new TypeError('执行记录 ID 无效');
  return join(root, 'prompt-runs', `${id}.json`);
}

export async function withPromptExecution({ outputRoot, configuration, kind, query = '' }, action) {
  const id = randomUUID();
  const path = pathFor(outputRoot, id);
  const runtime = configuration.promptRuntime;
  const state = { id, kind, query, source: configuration.source, startedAt: new Date().toISOString(),
    finishedAt: null, status: 'RUNNING', runtime, calls: [], error: null };
  await mkdir(join(outputRoot, 'prompt-runs'), { recursive: true });
  let pending = Promise.resolve();
  const save = () => {
    const content = JSON.stringify(redacted(state), null, 2);
    // Per-run writes are serialized; a reader always sees a complete JSON file.
    pending = pending.catch(() => {}).then(async () => {
      await writeFile(`${path}.tmp`, content);
      await rename(`${path}.tmp`, path);
    });
    return pending;
  };
  const controlPlane = { async recordModelCall(_executionId, callId, record) {
    const index = state.calls.findIndex((item) => item.id === callId);
    if (index < 0) state.calls.push(record); else state.calls[index] = record;
    await save();
  } };
  await save();
  try {
    const value = await withPromptRuntime(runtime, () => withModelCallTracing({ executionId: id,
      controlPlane, snapshot: runtime }, () => action(id)));
    state.status = 'SUCCEEDED';
    state.outcome = value;
    return value;
  } catch (error) {
    state.status = 'FAILED'; state.error = safeTraceText(String(error?.message ?? error)).text;
    throw error;
  } finally {
    state.finishedAt = new Date().toISOString();
    await save().catch(() => console.warn(`执行记录保存未完成：${id}；保留模型结果，不重放模型请求。`));
  }
}

export async function readPromptExecution(outputRoot, id) {
  return JSON.parse(await readFile(pathFor(outputRoot, id), 'utf8'));
}

export async function listPromptExecutions(outputRoot) {
  const directory = join(outputRoot, 'prompt-runs');
  const names = await readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  const recent = [];
  for (const name of names.filter((name) => uuid.test(name.replace(/\.json$/u, '')) && name.endsWith('.json'))) {
    recent.push({ name, modified: (await stat(join(directory, name))).mtimeMs });
  }
  const rows = [];
  for (const { name } of recent.sort((a, b) => b.modified - a.modified).slice(0, 50)) {
    const { id, kind, query, source, startedAt, finishedAt, status, error, calls } = JSON.parse(await readFile(join(directory, name), 'utf8'));
    rows.push({ id, kind, query, source, startedAt, finishedAt, status, error, callCount: calls.length });
  }
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
