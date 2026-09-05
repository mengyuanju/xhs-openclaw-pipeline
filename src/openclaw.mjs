import { existsSync, unlinkSync } from 'node:fs';
import { tracedOpenClawRunner } from './model-call-trace.mjs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import sharp from 'sharp';

import {
  effectiveModelApiConfig,
  validatedModelRef,
} from './model-api-config.mjs';
import { withWebSearchProvider } from './web-search-service.mjs';
import { receiveOpenClawImage } from './image-output-reception.mjs';

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 120_000;
const DEFAULT_VISION_TIMEOUT_MS = 300_000;
const DEFAULT_TEXT_THINKING = 'high';
const IMAGE_GENERATION_SIZE = '1152x1536';
const TRANSPORT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const WEB_SEARCH_RETRY_DELAYS_MS = [2_000];
const TRANSIENT_TRANSPORT_ERROR = /\b(?:EBUSY|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|UND_ERR_SOCKET)\b|fetch failed|connection error|other side closed|reconnecting|timed?\s*out/iu;
const BLOCKED_NETWORK_TARGET_ERROR = /blocked URL fetch|Blocked hostname|Blocked: resolves to private\/internal\/special-use IP address/iu;
const TEXT_THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const TEXT_CONTEXT_ERROR_CODES = new Set([
  'model_context_limit', 'context_length_exceeded', 'context_window_exceeded',
  'context_overflow', 'cli_context_overflow', 'prompt_too_long',
]);
const TEXT_CONTEXT_ERROR_MESSAGE = /maximum context length|\b(?:prompt|input) is too long\b|\binput exceeds the context window\b|\bcontext (?:window|length|limit) (?:is |was )?exceeded\b/iu;
const TEXT_LENGTH_FINISH_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens']);

let textInferenceTail = Promise.resolve();

async function runTextExclusively(operation) {
  const previous = textInferenceTail.catch(() => undefined);
  let release;
  textInferenceTail = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

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
  retryProcessTimeouts = false,
  retryDelaysMs = TRANSPORT_RETRY_DELAYS_MS,
}) {
  let result;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    result = await runner(
      nodePath,
      argsForAttempt?.(attempt) ?? args,
      optionsForAttempt?.(attempt) ?? options,
    );
    const processSucceeded = !result.error && result.status === 0;
    const succeeded = processSucceeded && (await verifySuccess?.(result) ?? true);
    if (succeeded) return result;
    const missingExpectedOutput = processSucceeded && Boolean(verifySuccess);
    const detail = missingExpectedOutput ? 'expected output file missing' : failureDetail(result);
    if (BLOCKED_NETWORK_TARGET_ERROR.test(detail)) return result;
    const childProcessTimedOut = result.error?.code === 'ETIMEDOUT';
    const retryable = childProcessTimedOut
      ? retryProcessTimeouts
      : missingExpectedOutput || TRANSIENT_TRANSPORT_ERROR.test(detail);
    if (!retryable || attempt === retryDelaysMs.length) {
      return result;
    }
    await beforeRetry?.();
    await sleep(retryDelaysMs[attempt]);
  }
  return result;
}

function redact(value) {
  return String(value ?? '')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED_TOKEN]')
    .slice(0, 4_000);
}

function actionableImageFailureDetail(result) {
  const rawDetail = failureDetail(result);
  if (/Blocked: resolves to private\/internal\/special-use IP address/iu.test(rawDetail)) {
    const target = rawDetail.match(/targetOrigin=(https?:\/\/\S+)/u)?.[1];
    let origin = '';
    try {
      origin = target ? new URL(target).origin : '';
    } catch {
      // Diagnostics can contain malformed URLs; never obscure the network error.
    }
    return `OpenClaw 安全校验拦截了图片请求${origin ? `（${redact(origin).slice(0, 200)}）` : ''}：域名解析到私有、内部或保留 IP，可能由 TUN/Fake-IP 引起。请检查图片代理 XHS_IMAGE_PROXY_URL 或代理 DNS 配置。`;
  }
  const detail = redact(rawDetail);
  if (/not supported when using Codex with a ChatGPT account/iu.test(detail)) {
    return 'ChatGPT/Codex OAuth 不能用于此图片生成接口。请在 .env 配置 OPENAI_API_KEY，或配置其他 OpenClaw 图片提供方凭据。';
  }
  return detail;
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

function withAbortSignal(options, signal) {
  if (signal === undefined) return options;
  if (typeof signal !== 'object' || typeof signal.aborted !== 'boolean') {
    throw new TypeError('signal must be an AbortSignal');
  }
  signal.throwIfAborted?.();
  return { ...options, signal };
}

function validatedTextThinking(value = DEFAULT_TEXT_THINKING) {
  const thinking = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!TEXT_THINKING_LEVELS.has(thinking)) {
    throw new TypeError(`thinking must be one of: ${[...TEXT_THINKING_LEVELS].join(', ')}`);
  }
  return thinking;
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

function assertGatewayTextCapacity(envelope) {
  // Only known envelope metadata is evidence. Never walk final/text/content/payloads.
  const nodes = [
    envelope, envelope?.result, envelope?.meta, envelope?.meta?.agentMeta,
    envelope?.result?.meta, envelope?.result?.meta?.agentMeta,
  ].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  const codes = nodes.flatMap((node) => [node.code, node.error?.code, node.error?.type,
    node.error?.kind, node.error?.reason])
    .filter((value) => typeof value === 'string').map((value) => value.toLowerCase());
  if (codes.some((code) => TEXT_CONTEXT_ERROR_CODES.has(code))
    || nodes.some((node) => typeof node.error?.message === 'string'
      && TEXT_CONTEXT_ERROR_MESSAGE.test(node.error.message))) {
    throw Object.assign(new Error('OpenClaw Gateway text inference exceeded the model context limit'), {
      code: 'MODEL_CONTEXT_LIMIT',
    });
  }
  if (codes.includes('model_output_incomplete') || nodes.some((node) => node.status === 'incomplete'
    || [node.finish_reason, node.finishReason, node.stopReason, node.choices?.[0]?.finish_reason]
      .some((reason) => TEXT_LENGTH_FINISH_REASONS.has(reason)))) {
    throw Object.assign(new Error('OpenClaw Gateway text inference output is incomplete'), {
      code: 'MODEL_OUTPUT_INCOMPLETE',
    });
  }
}

function assertSerializedGatewayTextCapacity(value) {
  let envelope;
  try {
    envelope = JSON.parse(String(value ?? ''));
  } catch {
    return;
  }
  assertGatewayTextCapacity(envelope);
}

function extractGatewayText(stdout) {
  const text = String(stdout ?? '').trim();
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error('OpenClaw Gateway returned invalid JSON');
  }
  assertGatewayTextCapacity(envelope);
  if (typeof envelope?.status === 'string' && envelope.status !== 'ok') {
    const detail = findText(envelope.error ?? envelope.message ?? envelope.result) ?? envelope.status;
    throw new Error(`OpenClaw Gateway agent run ${envelope.status}: ${redact(detail)}`);
  }
  const rawText = findText(envelope?.result?.payloads ?? envelope);
  if (!rawText) throw new Error('OpenClaw Gateway agent run returned no text payload');
  return { envelope, rawText };
}

function validatedAgentId(value) {
  const agentId = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(agentId)) {
    throw new TypeError('OpenClaw agent id is invalid');
  }
  return agentId;
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
  agentId = process.env.XHS_OPENCLAW_AGENT_ID || 'main',
  sessionPrefix = 'xhs',
  environment = process.env,
  fetchImpl = fetch,
} = {}) {
  const resolvedEntry = resolveEntryPath(entryPath);
  const resolvedAsyncRunner = tracedOpenClawRunner(asyncRunner
    ?? (runner === spawnSync ? runProcessAsync : async (...args) => runner(...args)));
  const resolvedAsyncSleep = asyncSleep ?? (async (milliseconds) => sleep(milliseconds));
  const currentModelApi = () => effectiveModelApiConfig(modelApi ?? {}, process.env);

  async function executeImage(args, outputPath, configuration, timeoutMs, signal, failureLabel) {
    let directory = await mkdtemp(join(dirname(resolve(outputPath)), '.image-output-'));
    let requestedPath = join(directory, 'image.png');
    let startedAt = Date.now();
    let received = false;
    const outputIndex = args.indexOf('--output') + 1;
    args[outputIndex] = requestedPath;
    try {
      const result = await runWithTransportRetryAsync({
        runner: resolvedAsyncRunner, nodePath, args, sleep: resolvedAsyncSleep,
        beforeRetry: async () => {
          // Start a fresh invocation boundary; an earlier attempt can never satisfy the new one.
          removePartialOutput(requestedPath);
          directory = await mkdtemp(join(dirname(resolve(outputPath)), '.image-output-'));
          requestedPath = join(directory, 'image.png');
          args[outputIndex] = requestedPath;
          startedAt = Date.now();
        },
        verifySuccess: async (result) => {
          received = await receiveOpenClawImage({ result, directory, requestedPath, outputPath, startedAt });
          return received;
        },
        options: withImageProxy(withAbortSignal({
          encoding: 'utf8', windowsHide: true, shell: false,
          timeout: timeoutMs + 10_000, maxBuffer: 10 * 1024 * 1024,
        }, signal), configuration.imageProxyUrl),
      });
      if (result.error || result.status !== 0) {
        throw new Error(`OpenClaw ${failureLabel} failed: ${actionableImageFailureDetail(result)}`);
      }
      if (!received) throw new Error('OpenClaw reported success but did not create the image file');
    } catch (error) {
      error.recoveryDirectory = directory;
      throw error;
    } finally {
      // Cleanup failure must not turn successfully received pixels into another model request.
      if (received) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  return withWebSearchProvider({
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
      timeoutMs = 120_000,
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
        retryProcessTimeouts: true,
        retryDelaysMs: WEB_SEARCH_RETRY_DELAYS_MS,
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

    async runText({ prompt, model, thinking, timeoutMs = 180_000, signal }) {
      if (typeof prompt !== 'string' || prompt.length === 0) {
        throw new RangeError('prompt must be a non-empty string');
      }
      const configuration = currentModelApi();
      const resolvedModel = validatedModelRef(model, configuration.textModel, 'textModel');
      const resolvedThinking = validatedTextThinking(thinking);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 540_000) {
        throw new RangeError('text timeoutMs must be an integer between 30000 and 540000');
      }
      const resolvedAgentId = validatedAgentId(agentId);
      const normalizedSessionPrefix = typeof sessionPrefix === 'string' ? sessionPrefix.trim() : '';
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(normalizedSessionPrefix)) {
        throw new TypeError('OpenClaw session prefix is invalid');
      }

      return runTextExclusively(async () => {
        const sessionId = `${normalizedSessionPrefix}-${randomUUID()}`;
        const directory = await mkdtemp(join(tmpdir(), 'xhs-openclaw-text-'));
        const messagePath = join(directory, 'message.txt');
        try {
          await writeFile(messagePath, prompt, 'utf8');
          const args = [
            resolvedEntry,
            'agent',
            '--agent',
            resolvedAgentId,
            '--session-id',
            sessionId,
            '--model',
            resolvedModel,
            '--thinking',
            resolvedThinking,
            '--timeout',
            String(Math.ceil(timeoutMs / 1_000)),
            '--json',
            '--message-file',
            messagePath,
          ];
          const processOptions = withAbortSignal({
            encoding: 'utf8',
            windowsHide: true,
            shell: false,
            timeout: timeoutMs + 45_000,
            maxBuffer: 10 * 1024 * 1024,
          }, signal);
          let result;
          try {
            result = await resolvedAsyncRunner(nodePath, args, processOptions);
          } catch (error) {
            // A runner message can contain the failed command/prompt; trust only its code.
            assertGatewayTextCapacity({ code: error?.code });
            throw error;
          }
          if (result.error || result.status !== 0) {
            assertGatewayTextCapacity({ code: result.error?.code });
            assertSerializedGatewayTextCapacity(result.stdout);
            assertSerializedGatewayTextCapacity(result.stderr);
            const detail = redact(failureDetail(result));
            throw new Error(`OpenClaw Gateway text inference failed: ${detail}`);
          }
          const parsed = extractGatewayText(result.stdout);
          const harnessRuntime = parsed.envelope?.result?.meta?.agentMeta?.agentHarnessId ?? 'codex';
          return {
            rawText: parsed.rawText,
            model: resolvedModel,
            thinking: resolvedThinking,
            execution: {
              runtime: String(harnessRuntime),
              sessionId,
              runId: typeof parsed.envelope?.runId === 'string' ? parsed.envelope.runId : null,
            },
          };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    },

    async runReview({ prompt, model, thinking, timeoutMs = 180_000, signal }) {
      const reviewModel = validatedModelRef(model, currentModelApi().reviewModel, 'reviewModel');
      return this.runText({ prompt, model: reviewModel, thinking, timeoutMs, signal });
    },

    async runVision({
      prompt,
      inputPaths,
      model,
      timeoutMs = DEFAULT_VISION_TIMEOUT_MS,
      signal,
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
        const processOptions = withAbortSignal({
          encoding: 'utf8',
          windowsHide: true,
          shell: false,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        }, signal);
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
      signal,
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
      await executeImage(args, outputPath, configuration, resolvedTimeoutMs, signal, 'image generation');
      return { outputPath, model: resolvedModel };
    },

    async runImageEdit({
      prompt,
      inputPaths,
      outputPath,
      model,
      timeoutMs,
      signal,
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
      await executeImage(args, outputPath, configuration, resolvedTimeoutMs, signal, 'image edit');
      return { outputPath, model: resolvedModel };
    },
  }, { environment, fetchImpl, settings: modelApi ?? {} });
}
