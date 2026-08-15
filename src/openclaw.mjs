import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_TEXT_MODEL = 'openai-codex/gpt-5.4-mini';

function redact(value) {
  return String(value ?? '')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED_TOKEN]')
    .slice(0, 4_000);
}

function resolveEntryPath(explicitPath) {
  if (explicitPath) return explicitPath;
  if (process.env.OPENCLAW_ENTRY) return process.env.OPENCLAW_ENTRY;

  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', 'openclaw', 'dist', 'index.js'));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('OpenClaw entry not found; set OPENCLAW_ENTRY to its dist/index.js path');
}

function findText(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findText(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const key of ['final', 'outputText', 'output_text', 'text', 'content', 'message', 'outputs', 'result']) {
      if (key in value) {
        const found = findText(value[key]);
        if (found) return found;
      }
    }
  }
  return null;
}

function extractModelText(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) throw new Error('OpenClaw returned empty stdout');
  try {
    const envelope = JSON.parse(text);
    return findText(envelope) ?? text;
  } catch {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        const envelope = JSON.parse(text.slice(firstBrace, lastBrace + 1));
        return findText(envelope) ?? text;
      } catch {
        return text;
      }
    }
    return text;
  }
}

export function createOpenClawClient({ entryPath, runner = spawnSync } = {}) {
  const resolvedEntry = resolveEntryPath(entryPath);

  return {
    runText({ prompt, model = process.env.XHS_TEXT_MODEL || DEFAULT_TEXT_MODEL, timeoutMs = 180_000 }) {
      if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 30_000) {
        throw new RangeError('prompt must contain between 1 and 30000 characters');
      }
      const args = [
        resolvedEntry,
        'infer',
        'model',
        'run',
        '--local',
        '--model',
        model,
        '--json',
        '--prompt',
        prompt,
      ];
      const result = runner(process.execPath, args, {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) {
        const detail = redact(result.stderr || result.error?.message || `exit status ${result.status}`);
        throw new Error(`OpenClaw text inference failed: ${detail}`);
      }
      return { rawText: extractModelText(result.stdout), model };
    },
  };
}
