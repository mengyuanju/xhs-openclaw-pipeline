import { safeTraceText } from './model-call-trace.mjs';

export function codexErrorCode(error) {
  const seen = new Set();
  for (let current = error; current && typeof current === 'object' && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (typeof current.code === 'string' && current.code.startsWith('CODEX_')) return current.code;
  }
  return null;
}

export function codexFailure(error = {}, fallbackCode = 'CODEX_EXEC_FAILED') {
  // Inspect transport metadata only; never classify words in a model's answer.
  const detail = [error.code, error.type, error.kind, error.message].filter(Boolean).join(' ');
  let code = fallbackCode;
  if (/usage[_ -]limit|quota|insufficient_quota|credits? (?:exhausted|depleted)|hit your.*limit/iu.test(detail)) code = 'CODEX_QUOTA_EXHAUSTED';
  else if (/invalid_grant|refresh_token|unauthoriz|not logged in|login required|authentication|\b401\b/iu.test(detail)) code = 'CODEX_AUTH_REQUIRED';
  else if (/rate[_ -]limit|too many requests|\b429\b/iu.test(detail)) code = 'CODEX_RATE_LIMITED';
  else if (/context[_ -](?:length|window|limit)|input exceeds the context window|prompt.*too long/iu.test(detail)) code = 'MODEL_CONTEXT_LIMIT';
  else if (/max_output_tokens|output.*incomplete|\blength\b/iu.test(detail)) code = 'MODEL_OUTPUT_INCOMPLETE';
  const guidance = {
    CODEX_AUTH_REQUIRED: '请在执行主机运行 codex login，再运行 npm run agent:resume。',
    CODEX_QUOTA_EXHAUSTED: '订阅额度不足；额度恢复后运行 npm run agent:resume。',
    CODEX_RATE_LIMITED: '请求限流，已进入共享冷却期。',
  }[code] ?? '';
  return Object.assign(new Error(`Codex ${code}: ${safeTraceText(detail).text.slice(0, 4000)} ${guidance}`.trim()), {
    code,
    haltWorker: ['CODEX_AUTH_REQUIRED', 'CODEX_QUOTA_EXHAUSTED'].includes(code),
  });
}

export function parseCodexOutput(stdout, { requireText = true } = {}) {
  let events;
  try {
    events = String(stdout ?? '').split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch {
    throw codexFailure({ message: 'invalid JSONL output' }, 'MODEL_OUTPUT_INCOMPLETE');
  }
  let rawText = '';
  let threadId = null;
  let completed = false;
  let usage = null;
  let searched = false;
  const images = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') throw codexFailure({}, 'MODEL_OUTPUT_INCOMPLETE');
    if (event.type === 'thread.started') threadId = event.thread_id ?? null;
    if (event.type === 'turn.started') completed = false;
    if (event.type === 'turn.failed' || event.type === 'error') {
      throw codexFailure(event.error ?? event);
    }
    if (event.type === 'turn.completed') {
      if (event.status === 'incomplete' || ['length', 'max_output_tokens'].includes(event.finish_reason)) {
        throw codexFailure({}, 'MODEL_OUTPUT_INCOMPLETE');
      }
      completed = true;
      usage = event.usage ?? null;
    }
    if (event.type !== 'item.completed') continue;
    const item = event.item;
    if (item?.type === 'agent_message') rawText = typeof item.text === 'string' ? item.text : '';
    if (item?.type === 'web_search' && !['failed', 'in_progress'].includes(item.status)) searched = true;
    if (['image_generation', 'imageGeneration'].includes(item?.type)) {
      if (item.failure) throw codexFailure(item.failure);
      if (item.status !== 'completed') throw codexFailure({ message: 'image_generation did not complete' }, 'CODEX_IMAGE_UNVERIFIED');
      const path = item.saved_path ?? item.savedPath;
      if (typeof path === 'string' && path && !images.some((image) => image.id === item.id && image.path === path)) {
        images.push({ id: item.id, path });
      }
    }
  }
  if (!completed || (requireText && !rawText.trim())) throw codexFailure({ message: 'missing completed turn or final message' }, 'MODEL_OUTPUT_INCOMPLETE');
  return { rawText, threadId, usage, searched, images };
}
