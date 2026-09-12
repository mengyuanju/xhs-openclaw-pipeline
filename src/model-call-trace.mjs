import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { withPromptTraceContext, requestPromptProvenance } from './prompt-trace-context.mjs';
import { promptRuntimeSnapshot } from './prompt-runtime.mjs';

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

export function withModelCallTracing({ executionId, controlPlane, snapshot }, action) {
  if (typeof controlPlane.recordModelCall !== 'function') return action(controlPlane);
  const state = { sequence: 0, stage: 'STARTING', stageDetails: {}, executionId, controlPlane };
  const tracedPlane = new Proxy(controlPlane, {
    get(target, key) {
      if (key === 'updateProgress') return (id, progress) => {
        if (id === executionId) {
          state.stage = progress.stage;
          state.stageDetails = progress.details && typeof progress.details === 'object'
            && !Array.isArray(progress.details) ? progress.details : {};
        }
        return target.updateProgress(id, progress);
      };
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    },
  });
  return withPromptTraceContext(snapshot, () => contexts.run(state, () => action(tracedPlane)));
}

export async function traceModelCall(metadata, operation, secrets = []) {
  const context = contexts.getStore();
  if (!context) return operation({ response() {}, fail() {} });
  const started = Date.now();
  const prompt = safeTraceText(metadata.prompt, secrets);
  const stage = context.stage === 'STARTING'
    ? [...prompt.text.matchAll(/<trusted_business_rules kind="([A-Z_]+)">/gu)].at(-1)?.[1] ?? metadata.operation ?? context.stage
    : context.stage;
  const request = safeTraceText({ format: 'xhs-model-request', schemaVersion: 1,
    stageContext: { name: stage, details: context.stageDetails },
    scope: metadata.requestScope ?? 'UNSPECIFIED', provenance: {
      ...requestPromptProvenance(metadata.prompt),
      runtime: promptRuntimeSnapshot() ? { source: promptRuntimeSnapshot().source,
        capturedAt: promptRuntimeSnapshot().capturedAt, settings: promptRuntimeSnapshot().settings } : null,
    }, payload: metadata.request }, secrets);
  const record = {
    id: randomUUID(), sequence: ++context.sequence, stage,
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
      prompt: body.input ?? body.messages, request: body, requestScope: 'HTTP_BODY',
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
