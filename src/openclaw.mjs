import { existsSync, unlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import sharp from 'sharp';

import {
  effectiveModelApiConfig,
  validatedModelRef,
} from './model-api-config.mjs';

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 120_000;
const DEFAULT_VISION_TIMEOUT_MS = 300_000;
const DEFAULT_TEXT_THINKING = 'high';
const IMAGE_GENERATION_SIZE = '1152x1536';
const TRANSPORT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const TRANSIENT_TRANSPORT_ERROR = /\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|UND_ERR_SOCKET)\b|fetch failed|connection error|other side closed|reconnecting|model\/list timed out/iu;
const TEXT_THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const TEXT_RETRY_THINKING = Object.freeze({
  minimal: ['minimal', 'minimal', 'minimal', 'minimal'],
  low: ['low', 'minimal', 'minimal', 'minimal'],
  medium: ['medium', 'low', 'minimal', 'minimal'],
  high: ['high', 'medium', 'low', 'minimal'],
  xhigh: ['xhigh', 'high', 'medium', 'low'],
  max: ['max', 'high', 'medium', 'low'],
});

function nonBlockingSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runProcessAsync(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({
        status: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
        stdout,
        stderr,
        error: error ?? undefined,
      });
    });
  });
}

function removePartialOutput(path) {
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function prepareVisionPreviews(inputPaths) {
  const directory = await mkdtemp(join(tmpdir(), 'xhs-openclaw-vision-'));
  const previewPaths = inputPaths.map((_inputPath, index) => join(directory, `vision-${index + 1}.jpg`));
  try {
    await Promise.all(inputPaths.map((inputPath, index) => sharp(inputPath, {
      failOn: 'error',
      limitInputPixels: 40_000_000,
    })
      .rotate()
      .resize({
        width: 900,
        height: 1_200,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({
        quality: 90,
        chromaSubsampling: '4:4:4',
        mozjpeg: true,
      })
      .toFile(previewPaths[index])));
    return {
      inputPaths: previewPaths,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function failureDetail(result) {
  const details = [];
  const errorMessage = String(result?.error?.message ?? '').trim();
  const stderr = String(result?.stderr ?? '').trim();
  if (stderr) details.push(stderr);
  if (errorMessage && !details.includes(errorMessage)) details.push(errorMessage);
  return details.length > 0 ? details.join('\n') : `exit status ${result?.status}`;
}

async function runWithTransportRetryAsync({
  runner,
  nodePath,
  args,
  options,
  argsForAttempt,
  optionsForAttempt,
  sleep,
  beforeRetry,
  verifySuccess,
}) {
  let result;
  for (let attempt = 0; attempt <= TRANSPORT_RETRY_DELAYS_MS.length; attempt += 1) {
    result = await runner(
      nodePath,
      argsForAttempt?.(attempt) ?? args,
      optionsForAttempt?.(attempt) ?? options,
    );
    const processSucceeded = !result.error && result.status === 0;
    const succeeded = processSucceeded && (verifySuccess?.(result) ?? true);
    if (succeeded) return result;
    const missingExpectedOutput = processSucceeded && Boolean(verifySuccess);
    const detail = missingExpectedOutput ? 'expected output file missing' : failureDetail(result);
    const childProcessTimedOut = result.error?.code === 'ETIMEDOUT';
    if (childProcessTimedOut || (!missingExpectedOutput && !TRANSIENT_TRANSPORT_ERROR.test(detail))
      || attempt === TRANSPORT_RETRY_DELAYS_MS.length) {
      return result;
    }
    beforeRetry?.();
    await sleep(TRANSPORT_RETRY_DELAYS_MS[attempt]);
  }
  return result;
}

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

function resolvedImageTimeoutMs(value, configuredDefault) {
  const configured = value ?? configuredDefault;
  const timeoutMs = Number(configured);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 540_000) {
    throw new RangeError('image timeoutMs must be an integer between 30000 and 540000');
  }
  return timeoutMs;
}

function validatedTextThinking(value = DEFAULT_TEXT_THINKING) {
  const thinking = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!TEXT_THINKING_LEVELS.has(thinking)) {
    throw new TypeError(`thinking must be one of: ${[...TEXT_THINKING_LEVELS].join(', ')}`);
  }
  return thinking;
}

function textThinkingForAttempt(initialThinking, attempt) {
  const schedule = TEXT_RETRY_THINKING[initialThinking];
  return schedule[Math.min(attempt, schedule.length - 1)];
}

function withTextThinking(args, thinking) {
  const thinkingIndex = args.indexOf('--thinking');
  const nextArgs = [...args];
  nextArgs[thinkingIndex + 1] = thinking;
  return nextArgs;
}

function withImageProxy(options, proxyUrl) {
  if (!proxyUrl) return options;
  return {
    ...options,
    env: {
      ...process.env,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
    },
  };
}

function withModelProxy(options, proxyUrl) {
  if (!proxyUrl) return options;
  return {
    ...options,
    env: {
      ...process.env,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
    },
  };
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

function extractCapabilityResult(stdout, capability) {
  const text = String(stdout ?? '').trim();
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error(`OpenClaw ${capability} returned invalid JSON`);
  }
  const result = envelope?.outputs?.[0]?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`OpenClaw ${capability} returned an invalid result`);
  }
  return { envelope, result };
}

export function createOpenClawClient({
  entryPath,
  nodePath = process.env.OPENCLAW_NODE_PATH || process.execPath,
  modelApi = undefined,
  runner = spawnSync,
  sleep = nonBlockingSleep,
  asyncRunner,
  asyncSleep,
} = {}) {
  const resolvedEntry = resolveEntryPath(entryPath);
  const resolvedAsyncRunner = asyncRunner
    ?? (runner === spawnSync ? runProcessAsync : async (...args) => runner(...args));
  const resolvedAsyncSleep = asyncSleep ?? (async (milliseconds) => sleep(milliseconds));
  const currentModelApi = () => effectiveModelApiConfig(modelApi ?? {}, process.env);

  return {
    checkReady({ textModel, imageModel, timeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS } = {}) {
      const configuration = currentModelApi();
      const validatedTextModel = validatedModelRef(textModel, configuration.textModel, 'textModel');
      const validatedImageModel = validatedModelRef(imageModel, configuration.imageModel, 'imageModel');
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
        throw new RangeError('preflight timeoutMs must be between 1000 and 120000');
      }
      const result = runner(nodePath, [
        resolvedEntry,
        'models',
        'status',
        '--check',
        '--json',
      ], {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) {
        const detail = redact(failureDetail(result));
        throw new Error(`OpenClaw batch preflight failed: ${detail}`);
      }
      try {
        JSON.parse(String(result.stdout || ''));
      } catch {
        throw new Error('OpenClaw batch preflight failed: models status returned invalid JSON');
      }
      return { textModel: validatedTextModel, imageModel: validatedImageModel };
    },

    async runWebSearch({
      query,
      provider = 'codex',
      limit = 5,
      timeoutMs = 90_000,
    }) {
      const normalizedQuery = typeof query === 'string' ? query.trim() : '';
      const normalizedProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
      if (normalizedQuery.length < 1 || normalizedQuery.length > 500) {
        throw new RangeError('web search query must contain between 1 and 500 characters');
      }
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(normalizedProvider)) {
        throw new TypeError('web search provider is invalid');
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
        throw new RangeError('web search limit must be an integer between 1 and 10');
      }
      if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 120_000) {
        throw new RangeError('web search timeoutMs must be between 5000 and 120000');
      }
      const args = [
        resolvedEntry,
        'infer',
        'web',
        'search',
        '--provider',
        normalizedProvider,
        '--query',
        normalizedQuery,
        '--limit',
        String(limit),
        '--json',
      ];
      const processOptions = {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: timeoutMs,
        maxBuffer: 5 * 1024 * 1024,
      };
      const configuration = currentModelApi();
      const processResult = await runWithTransportRetryAsync({
        runner: resolvedAsyncRunner,
        nodePath,
        args,
        sleep: resolvedAsyncSleep,
        options: processOptions,
        optionsForAttempt: (attempt) => (attempt === 0
          ? withModelProxy(processOptions, configuration.modelProxyUrl)
          : processOptions),
      });
      if (processResult.error || processResult.status !== 0) {
        const detail = redact(failureDetail(processResult));
        throw new Error(`OpenClaw web search failed (${normalizedProvider}): ${detail}`);
      }
      const parsed = extractCapabilityResult(processResult.stdout, 'web search');
      return {
        provider: String(parsed.envelope.provider ?? parsed.result.provider ?? normalizedProvider),
        result: parsed.result,
      };
    },

    async runText({ prompt, model, thinking, timeoutMs = 180_000 }) {
      if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 30_000) {
        throw new RangeError('prompt must contain between 1 and 30000 characters');
      }
      const configuration = currentModelApi();
      const resolvedModel = validatedModelRef(model, configuration.textModel, 'textModel');
      const resolvedThinking = validatedTextThinking(thinking);
      const args = [
        resolvedEntry,
        'infer',
        'model',
        'run',
        '--local',
        '--model',
        resolvedModel,
        '--thinking',
        resolvedThinking,
        '--json',
        '--prompt',
        prompt,
      ];
      const processOptions = {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      };
      let completedThinking = resolvedThinking;
      const result = await runWithTransportRetryAsync({
        runner: resolvedAsyncRunner,
        nodePath,
        args,
        sleep: resolvedAsyncSleep,
        options: processOptions,
        argsForAttempt: (attempt) => {
          completedThinking = textThinkingForAttempt(resolvedThinking, attempt);
          return withTextThinking(args, completedThinking);
        },
        optionsForAttempt: (attempt) => (attempt === 0
          ? withModelProxy(processOptions, configuration.modelProxyUrl)
          : processOptions),
      });
      if (result.error || result.status !== 0) {
        const detail = redact(failureDetail(result));
        throw new Error(`OpenClaw text inference failed: ${detail}`);
      }
      return {
        rawText: extractModelText(result.stdout),
        model: resolvedModel,
        thinking: completedThinking,
      };
    },

    async runReview({ prompt, model, timeoutMs = 180_000 }) {
      const reviewModel = validatedModelRef(model, currentModelApi().reviewModel, 'reviewModel');
      return this.runText({ prompt, model: reviewModel, timeoutMs });
    },

    async runVision({
      prompt,
      inputPaths,
      model,
      timeoutMs = DEFAULT_VISION_TIMEOUT_MS,
    }) {
      if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 30_000) {
        throw new RangeError('vision prompt must contain between 1 and 30000 characters');
      }
      if (!Array.isArray(inputPaths) || inputPaths.length < 1 || inputPaths.length > 5) {
        throw new RangeError('vision inference requires between 1 and 5 input files');
      }
      for (const inputPath of inputPaths) {
        if (typeof inputPath !== 'string' || inputPath.length === 0 || inputPath.length > 1_000
          || !existsSync(inputPath)) {
          throw new TypeError('vision input file is invalid');
        }
      }
      const configuration = currentModelApi();
      const resolvedModel = validatedModelRef(model, configuration.visionModel, 'visionModel');
      const previews = await prepareVisionPreviews(inputPaths);
      try {
        const fileArgs = previews.inputPaths.flatMap((inputPath) => ['--file', inputPath]);
        const args = [
          resolvedEntry,
          'infer',
          'model',
          'run',
          '--local',
          '--model',
          resolvedModel,
          '--json',
          ...fileArgs,
          '--prompt',
          prompt,
        ];
        const processOptions = {
          encoding: 'utf8',
          windowsHide: true,
          shell: false,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        };
        const result = await runWithTransportRetryAsync({
          runner: resolvedAsyncRunner,
          nodePath,
          args,
          sleep: resolvedAsyncSleep,
          options: processOptions,
          optionsForAttempt: (attempt) => (attempt === 0
            ? withModelProxy(processOptions, configuration.modelProxyUrl)
            : processOptions),
        });
        if (result.error || result.status !== 0) {
          const detail = redact(failureDetail(result));
          throw new Error(`OpenClaw vision inference failed: ${detail}`);
        }
        return { rawText: extractModelText(result.stdout), model: resolvedModel };
      } finally {
        await previews.cleanup();
      }
    },

    async runImage({
      prompt,
      outputPath,
      model,
      timeoutMs,
    }) {
      if (typeof prompt !== 'string' || prompt.length < 10 || prompt.length > 8_000) {
        throw new RangeError('image prompt must contain between 10 and 8000 characters');
      }
      if (typeof outputPath !== 'string' || outputPath.length === 0 || outputPath.length > 1_000) {
        throw new TypeError('outputPath must be a non-empty string');
      }
      const configuration = currentModelApi();
      const resolvedModel = validatedModelRef(model, configuration.imageModel, 'imageModel');
      const resolvedTimeoutMs = resolvedImageTimeoutMs(timeoutMs, configuration.imageTimeoutMs);
      const args = [
        resolvedEntry,
        'infer',
        'image',
        'generate',
        '--model',
        resolvedModel,
        '--count',
        '1',
        '--size',
        IMAGE_GENERATION_SIZE,
        '--output-format',
        'png',
        '--output',
        outputPath,
        '--timeout-ms',
        String(resolvedTimeoutMs),
        '--json',
        '--prompt',
        prompt,
      ];
      const processOptions = {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: resolvedTimeoutMs + 10_000,
        maxBuffer: 10 * 1024 * 1024,
      };
      const result = await runWithTransportRetryAsync({
        runner: resolvedAsyncRunner,
        nodePath,
        args,
        sleep: resolvedAsyncSleep,
        beforeRetry: () => removePartialOutput(outputPath),
        verifySuccess: () => existsSync(outputPath),
        options: processOptions,
        optionsForAttempt: (attempt) => (attempt === 0
          ? withImageProxy(processOptions, configuration.imageProxyUrl)
          : processOptions),
      });
      if (result.error || result.status !== 0) {
        const detail = redact(failureDetail(result));
        throw new Error(`OpenClaw image generation failed: ${detail}`);
      }
      if (!existsSync(outputPath)) {
        throw new Error('OpenClaw reported success but did not create the image file');
      }
      return { outputPath, model: resolvedModel };
    },

    async runImageEdit({
      prompt,
      inputPaths,
      outputPath,
      model,
      timeoutMs,
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
      const configuration = currentModelApi();
      const resolvedModel = validatedModelRef(model, configuration.imageModel, 'imageModel');
      const resolvedTimeoutMs = resolvedImageTimeoutMs(timeoutMs, configuration.imageTimeoutMs);
      const fileArgs = inputPaths.flatMap((inputPath) => ['--file', inputPath]);
      const args = [
        resolvedEntry,
        'infer',
        'image',
        'edit',
        '--model',
        resolvedModel,
        ...fileArgs,
        '--size',
        IMAGE_GENERATION_SIZE,
        '--output-format',
        'png',
        '--output',
        outputPath,
        '--timeout-ms',
        String(resolvedTimeoutMs),
        '--json',
        '--prompt',
        prompt,
      ];
      const processOptions = {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: resolvedTimeoutMs + 10_000,
        maxBuffer: 10 * 1024 * 1024,
      };
      const result = await runWithTransportRetryAsync({
        runner: resolvedAsyncRunner,
        nodePath,
        args,
        sleep: resolvedAsyncSleep,
        beforeRetry: () => removePartialOutput(outputPath),
        verifySuccess: () => existsSync(outputPath),
        options: processOptions,
        optionsForAttempt: (attempt) => (attempt === 0
          ? withImageProxy(processOptions, configuration.imageProxyUrl)
          : processOptions),
      });
      if (result.error || result.status !== 0) {
        const detail = redact(failureDetail(result));
        throw new Error(`OpenClaw image edit failed: ${detail}`);
      }
      if (!existsSync(outputPath)) {
        throw new Error('OpenClaw reported success but did not create the edited image file');
      }
      return { outputPath, model: resolvedModel };
    },
  };
}
