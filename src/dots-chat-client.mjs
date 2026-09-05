import { tracedModelFetch } from './model-call-trace.mjs';
import {
  DEFAULT_DOTS_BASE_URL,
  DEFAULT_DOTS_MODEL,
  validatedDotsBaseUrl,
  validatedDotsModel,
} from './model-api-config.mjs';

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TOKENS = 8_192;
const CONTEXT_ERROR_CODES = new Set([
  'model_context_limit', 'context_length_exceeded', 'context_window_exceeded',
  'context_overflow', 'prompt_too_long',
]);
const CONTEXT_ERROR_MESSAGE = /maximum context length|\b(?:prompt|input) is too long\b|\binput exceeds the context window\b|\bcontext (?:window|length|limit) (?:is |was )?exceeded\b/iu;

function assertTextCapacity(payload) {
  // Inspect provider error/finish metadata only; assistant content is untrusted.
  const error = payload?.error;
  const codes = [error?.code, error?.type].filter((value) => typeof value === 'string')
    .map((value) => value.toLowerCase());
  if (codes.some((code) => CONTEXT_ERROR_CODES.has(code))
    || (typeof error?.message === 'string' && CONTEXT_ERROR_MESSAGE.test(error.message))) {
    throw Object.assign(new Error('Dots Chat Completions exceeded the model context limit'), {
      code: 'MODEL_CONTEXT_LIMIT',
    });
  }
  if (codes.includes('model_output_incomplete') || payload?.choices?.[0]?.finish_reason === 'length') {
    throw Object.assign(new Error('Dots Chat Completions output is incomplete'), {
      code: 'MODEL_OUTPUT_INCOMPLETE',
    });
  }
}

function requiredApiKey(value) {
  const apiKey = typeof value === 'string' ? value.trim() : '';
  if (!apiKey) {
    throw new Error('Dots API is not ready; set XHS_DOTS_API_KEY on the server');
  }
  if (apiKey.length > 2_000) throw new RangeError('XHS_DOTS_API_KEY is too long');
  return apiKey;
}

function responseContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim() || content.length > 200_000) {
    throw new TypeError('Dots Chat Completions response is invalid');
  }
  return content;
}

function validatedTimeout(value) {
  if (!Number.isInteger(value) || value < 1_000 || value > 300_000) {
    throw new RangeError('Dots timeoutMs must be between 1000 and 300000');
  }
  return value;
}

export function createDotsChatClient({
  apiKey = process.env.XHS_DOTS_API_KEY,
  baseUrl = DEFAULT_DOTS_BASE_URL,
  model = DEFAULT_DOTS_MODEL,
  fetchImpl = fetch,
  maxTokens = DEFAULT_MAX_TOKENS,
} = {}) {
  const endpoint = new URL('/v1/chat/completions', validatedDotsBaseUrl(baseUrl)).toString();
  const configuredModel = validatedDotsModel(model);
  fetchImpl = tracedModelFetch(fetchImpl, 'Dots');
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 32_768) {
    throw new RangeError('Dots maxTokens must be between 256 and 32768');
  }

  return {
    async runText({ prompt, timeoutMs = DEFAULT_TIMEOUT_MS }) {
      if (typeof prompt !== 'string' || prompt.length < 1) {
        throw new RangeError('prompt must be a non-empty string');
      }
      const secret = requiredApiKey(apiKey);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(validatedTimeout(timeoutMs)),
          headers: {
            'Content-Type': 'application/json',
            'api-key': secret,
          },
          body: JSON.stringify({
            model: configuredModel,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            max_tokens: maxTokens,
            chat_template_kwargs: { enable_thinking: false },
          }),
        });
      } catch {
        throw new Error('Dots Chat Completions network request failed');
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        if (response?.ok) throw new TypeError('Dots Chat Completions response is not valid JSON');
      }
      assertTextCapacity(payload);
      if (!response?.ok) {
        const status = Number.isInteger(response?.status) ? response.status : 502;
        throw new Error(`Dots Chat Completions failed with HTTP ${status}`);
      }
      return { rawText: responseContent(payload), model: configuredModel };
    },
  };
}
