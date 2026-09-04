import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const contexts = new AsyncLocalStorage();
const LIMIT = 200_000;

export function safeTraceText(value, secrets = []) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/\bsk-[a-zA-Z0-9_-]{8,}/gu, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"',}]+/giu, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|password|secret|access[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s"',}\n]+/giu, '$1[REDACTED]')
    .replace(/data:image\/[^;]+;base64,[a-zA-Z0-9+/=]+/gu, '[image data omitted]');
  return { text: text.slice(0, LIMIT), truncated: text.length > LIMIT };
}

export function withModelCallTracing({ executionId, controlPlane }, action) {
  if (typeof controlPlane.recordModelCall !== 'function') return action(controlPlane);
  const state = { sequence: 0, stage: 'STARTING', executionId, controlPlane };
  const tracedPlane = new Proxy(controlPlane, {
    get(target, key) {
      if (key === 'updateProgress') return (id, progress) => {
        if (id === executionId) state.stage = progress.stage;
        return target.updateProgress(id, progress);
      };
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    },
  });
  return contexts.run(state, () => action(tracedPlane));
}

export async function traceModelCall(metadata, operation, secrets = []) {
  const context = contexts.getStore();
  if (!context) return operation({ response() {}, fail() {} });
  const started = Date.now();
  const prompt = safeTraceText(metadata.prompt, secrets);
  const request = safeTraceText(metadata.request, secrets);
  const record = {
    id: randomUUID(), sequence: ++context.sequence, stage: context.stage,
    provider: metadata.provider, operation: metadata.operation, model: metadata.model || '',
    prompt: prompt.text, request: request.text, response: null, error: null,
    truncated: prompt.truncated || request.truncated,
    status: 'RUNNING', startedAt: new Date(started).toISOString(), finishedAt: null, durationMs: null,
  };
  async function save() {
    // Logging failures must never cause a model call to be replayed.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await context.controlPlane.recordModelCall(context.executionId, record.id, { ...record });
        return;
      } catch {
        if (attempt === 1) console.warn(`模型调用记录上传失败：${record.id}（不重放模型请求）`);
      }
    }
  }
  const capture = {
    response(value) {
      const result = safeTraceText(value, secrets);
      record.response = result.text;
      record.truncated ||= result.truncated;
    },
    fail(message) {
      record.status = 'FAILED';
      record.error = safeTraceText(String(message), secrets).text.slice(0, 8_000);
    },
  };
  await save();
  try {
    const result = await operation(capture);
    if (record.status !== 'FAILED') record.status = 'SUCCEEDED';
    return result;
  } catch (error) {
    capture.fail(error?.message ?? error);
    throw error;
  } finally {
    record.finishedAt = new Date().toISOString();
    record.durationMs = Date.now() - started;
    await save();
  }
}

export function tracedModelFetch(fetchImpl, provider) {
  return async (url, options) => {
    if (!contexts.getStore()) return fetchImpl(url, options);
    const body = JSON.parse(options.body);
    const secrets = Object.entries(options.headers ?? {})
      .filter(([key]) => /authorization|api.key/iu.test(key))
      .map(([, value]) => String(value).replace(/^Bearer\s+/iu, ''));
    return traceModelCall({
      provider, model: body.model, operation: body.tools ? 'WEB_SEARCH' : 'TEXT',
      prompt: body.input ?? body.messages, request: body,
    }, async (capture) => {
      const response = await fetchImpl(url, options);
      // Read a clone: preserve the original body's parsing and error behavior.
      if (typeof response?.clone === 'function') {
        try {
          const raw = await response.clone().text();
          capture.response(raw);
          try {
            const payload = JSON.parse(raw);
            if (payload?.error || (payload?.status && payload.status !== 'completed')) {
              capture.fail(payload.error?.message ?? `模型响应状态：${payload.status}`);
            }
          } catch { capture.fail('模型接口响应不是有效 JSON'); }
        }
        catch { capture.fail('响应正文读取失败'); }
      }
      if (!response?.ok) capture.fail(`HTTP ${response?.status ?? 'unknown'}`);
      return response;
    }, secrets);
  };
}

export function tracedOpenClawRunner(runner) {
  return async (command, args, options) => {
    if (!contexts.getStore()) return runner(command, args, options);
    const flag = (key) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
    let prompt = flag('--prompt') ?? flag('--query');
    if (flag('--message-file')) {
      try { prompt = await readFile(flag('--message-file'), 'utf8'); }
      catch { return runner(command, args, options); }
    }
    if (prompt === undefined) return runner(command, args, options);
    const operation = args.includes('agent') ? 'TEXT'
      : args.includes('search') ? 'WEB_SEARCH'
        : args.includes('image') ? (args.includes('edit') ? 'IMAGE_EDIT' : 'IMAGE') : 'VISION';
    // Do not record process options: env can contain credentials.
    const secrets = Object.entries(options?.env ?? process.env)
      .filter(([key, value]) => /(?:API_KEY|TOKEN|PASSWORD|SECRET)$/iu.test(key) && typeof value === 'string' && value.length >= 8)
      .map(([, value]) => value);
    return traceModelCall({
      provider: 'OpenClaw', operation, model: flag('--model'), prompt,
      request: { operation, model: flag('--model'), thinking: flag('--thinking'),
        searchProvider: flag('--provider'), sessionId: flag('--session-id'),
        files: args.flatMap((arg, index) => arg === '--file' ? [args[index + 1]] : []) },
    }, async (capture) => {
      const result = await runner(command, args, options);
      capture.response({ stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? ''), exitCode: result.status });
      if (result.error || result.status !== 0) capture.fail(result.error?.message ?? `OpenClaw exit ${result.status}`);
      return result;
    }, secrets);
  };
}
