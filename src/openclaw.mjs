import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_TEXT_MODEL = 'openai-codex/gpt-5.4-mini';
const DEFAULT_IMAGE_MODEL = 'openai/gpt-image-2';

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

    runVision({
      prompt,
      inputPaths,
      model = process.env.XHS_VISION_MODEL || process.env.XHS_TEXT_MODEL || DEFAULT_TEXT_MODEL,
      timeoutMs = 180_000,
    }) {
      if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 30_000) {
        throw new RangeError('vision prompt must contain between 1 and 30000 characters');
      }
      if (!Array.isArray(inputPaths) || inputPaths.length < 1 || inputPaths.length > 3) {
        throw new RangeError('vision inference requires between 1 and 3 input files');
      }
      for (const inputPath of inputPaths) {
        if (typeof inputPath !== 'string' || inputPath.length === 0 || inputPath.length > 1_000
          || !existsSync(inputPath)) {
          throw new TypeError('vision input file is invalid');
        }
      }
      const fileArgs = inputPaths.flatMap((inputPath) => ['--file', inputPath]);
      const args = [
        resolvedEntry,
        'infer',
        'model',
        'run',
        '--local',
        '--model',
        model,
        '--json',
        ...fileArgs,
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
        throw new Error(`OpenClaw vision inference failed: ${detail}`);
      }
      return { rawText: extractModelText(result.stdout), model };
    },

    runImage({
      prompt,
      outputPath,
      model = process.env.XHS_IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
      timeoutMs = 180_000,
    }) {
      if (typeof prompt !== 'string' || prompt.length < 10 || prompt.length > 8_000) {
        throw new RangeError('image prompt must contain between 10 and 8000 characters');
      }
      if (typeof outputPath !== 'string' || outputPath.length === 0 || outputPath.length > 1_000) {
        throw new TypeError('outputPath must be a non-empty string');
      }
      const args = [
        resolvedEntry,
        'infer',
        'image',
        'generate',
        '--model',
        model,
        '--count',
        '1',
        '--size',
        '1024x1536',
        '--output-format',
        'png',
        '--output',
        outputPath,
        '--timeout-ms',
        String(timeoutMs),
        '--json',
        '--prompt',
        prompt,
      ];
      const result = runner(process.execPath, args, {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: timeoutMs + 10_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) {
        const detail = redact(result.stderr || result.error?.message || `exit status ${result.status}`);
        throw new Error(`OpenClaw image generation failed: ${detail}`);
      }
      if (!existsSync(outputPath)) {
        throw new Error('OpenClaw reported success but did not create the image file');
      }
      return { outputPath, model };
    },

    runImageEdit({
      prompt,
      inputPaths,
      outputPath,
      model = process.env.XHS_IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
      timeoutMs = 180_000,
    }) {
      if (typeof prompt !== 'string' || prompt.length < 10 || prompt.length > 8_000) {
        throw new RangeError('image edit prompt must contain between 10 and 8000 characters');
      }
      if (!Array.isArray(inputPaths) || inputPaths.length < 1 || inputPaths.length > 10) {
        throw new RangeError('image edit requires between 1 and 10 input files');
      }
      for (const inputPath of inputPaths) {
        if (typeof inputPath !== 'string' || inputPath.length === 0 || inputPath.length > 1_000
          || !existsSync(inputPath)) {
          throw new TypeError('image edit input file is invalid');
        }
      }
      if (typeof outputPath !== 'string' || outputPath.length === 0 || outputPath.length > 1_000) {
        throw new TypeError('outputPath must be a non-empty string');
      }
      const fileArgs = inputPaths.flatMap((inputPath) => ['--file', inputPath]);
      const args = [
        resolvedEntry,
        'infer',
        'image',
        'edit',
        '--model',
        model,
        ...fileArgs,
        '--size',
        '1024x1536',
        '--output-format',
        'png',
        '--output',
        outputPath,
        '--timeout-ms',
        String(timeoutMs),
        '--json',
        '--prompt',
        prompt,
      ];
      const result = runner(process.execPath, args, {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: timeoutMs + 10_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) {
        const detail = redact(result.stderr || result.error?.message || `exit status ${result.status}`);
        throw new Error(`OpenClaw image edit failed: ${detail}`);
      }
      if (!existsSync(outputPath)) {
        throw new Error('OpenClaw reported success but did not create the edited image file');
      }
      return { outputPath, model };
    },
  };
}
