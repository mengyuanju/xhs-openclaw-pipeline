import { createResearchSnapshot, normalizeResearchEvidence, requiresAuthoritativeResearch } from '../src/research.mjs';
import { providerCatalogue, runProviderSearch } from './providers.mjs';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

function redact(value, secrets) {
  if (typeof value === 'string') {
    let cleaned = value;
    for (const secret of secrets) {
      if (secret.length >= 4) cleaned = cleaned.replaceAll(secret, '[REDACTED_API_KEY]');
    }
    return cleaned;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]));
  }
  return value;
}

function normalizedSelection(value, catalogue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('服务商配置格式不正确');
  }
  const provider = catalogue.find((item) => item.id === value.id);
  if (!provider || provider.available === false) throw new TypeError('所选服务商暂不支持 API 测试');
  const key = typeof value.key === 'string' ? value.key.trim() : '';
  if (provider.needsKey && (!key || key.length > 2048 || /\s/u.test(key))) {
    throw new TypeError(`${provider.label} API key 缺失或格式不正确`);
  }
  const model = value.model == null || value.model === ''
    ? provider.defaultModel ?? null
    : String(value.model).trim();
  if (model !== null && !MODEL_ID.test(model)) throw new TypeError(`${provider.label} 模型 ID 不正确`);
  const suppliedOptions = value.options ?? {};
  if (!suppliedOptions || typeof suppliedOptions !== 'object' || Array.isArray(suppliedOptions)) {
    throw new TypeError(`${provider.label} 附加参数格式不正确`);
  }
  const options = {};
  const fields = provider.fields ?? [];
  for (const field of fields) {
    const input = suppliedOptions[field.name];
    if (field.type === 'boolean') {
      if (input !== undefined && typeof input !== 'boolean') {
        throw new TypeError(`${provider.label} ${field.label}不正确`);
      }
      options[field.name] = input ?? (field.defaultValue === true);
      continue;
    }
    const normalized = typeof input === 'string' ? input.trim() : '';
    if ((field.required && !normalized) || normalized.length > 256
      || (normalized && field.pattern && !(new RegExp(field.pattern, 'u')).test(normalized))) {
      throw new TypeError(`${provider.label} ${field.label}不正确`);
    }
    if (normalized) options[field.name] = normalized;
  }
  return { provider, key, model, options };
}

export function validateCompareRequest(body, catalogue = providerCatalogue) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('请求格式不正确');
  const query = typeof body.query === 'string' ? body.query.replace(/\s+/gu, ' ').trim() : '';
  if (!query || [...query].length > 500) throw new RangeError('Query 需要 1–500 个字符');
  if (!Array.isArray(body.providers) || body.providers.length < 1 || body.providers.length > 12) {
    throw new RangeError('请选择 1–12 家服务商');
  }
  const selections = body.providers.map((item) => normalizedSelection(item, catalogue));
  const ids = selections.map(({ provider }) => provider.id);
  if (new Set(ids).size !== ids.length) throw new TypeError('服务商不能重复选择');
  return { query, selections };
}

export async function compareSearch(body, {
  catalogue = providerCatalogue,
  search = runProviderSearch,
  now = () => performance.now(),
} = {}) {
  const { query, selections } = validateCompareRequest(body, catalogue);
  const results = await Promise.all(selections.map(async ({ provider, key, model, options }) => {
    const startedAt = now();
    const secrets = key ? [key] : [];
    let preview = null;
    try {
      // The production research engine treats providers as ordered fallbacks. Run
      // it once per provider here so every service gets the same Query and policy.
      const snapshot = await createResearchSnapshot({
        client: {
          webSearchProviders: [provider.id],
          async runWebSearch(input) {
            const response = await search({ id: provider.id, key, model, options, ...input });
            preview = normalizeResearchEvidence(response?.result, response?.provider ?? provider.id,
              new Date().toISOString());
            return response;
          },
        },
        query,
        providers: [provider.id],
        requireAuthoritative: requiresAuthoritativeResearch({ query }),
        supplementalSearch: false,
        citationOnlyProviders: ['codex', ...(provider.citationOnly ? [provider.id] : [])],
      });
      return {
        provider: provider.id,
        label: provider.label,
        kind: provider.kind ?? 'model-answer',
        status: snapshot.status,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        snapshot: redact(snapshot, secrets),
        ...(snapshot.status === 'FAILED' && preview?.sources.length
          ? { preview: redact(preview, secrets) } : {}),
      };
    } catch {
      return {
        provider: provider.id,
        label: provider.label,
        kind: provider.kind ?? 'model-answer',
        status: 'FAILED',
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        error: '服务商调用失败，请检查 key、模型和网络后重试',
      };
    }
  }));
  return { query, results };
}
