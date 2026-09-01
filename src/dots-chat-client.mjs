import {
  DEFAULT_DOTS_BASE_URL,
  DEFAULT_DOTS_MODEL,
  validatedDotsBaseUrl,
  validatedDotsModel,
} from './model-api-config.mjs';

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TOKENS = 8_192;

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
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 32_768) {
    throw new RangeError('Dots maxTokens must be between 256 and 32768');
  }

  return {
    async runText({ prompt, timeoutMs = DEFAULT_TIMEOUT_MS }) {
      if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > 30_000) {
        throw new RangeError('prompt must contain between 1 and 30000 characters');
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
      if (!response?.ok) {
        const status = Number.isInteger(response?.status) ? response.status : 502;
        throw new Error(`Dots Chat Completions failed with HTTP ${status}`);
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new TypeError('Dots Chat Completions response is not valid JSON');
      }
      return { rawText: responseContent(payload), model: configuredModel };
    },
  };
}
