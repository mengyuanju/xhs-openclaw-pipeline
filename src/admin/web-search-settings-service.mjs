import { DEFAULT_PRODUCTION_SETTINGS } from '../production-settings.mjs';
import { DEFAULT_DOUBAO_SEARCH_MODE, DEFAULT_WEB_SEARCH_SETTINGS,
  normalizeWebSearchSettings, resolveWebSearchConfig } from '../web-search-config.mjs';

function publicRecord(production, { controlPlane, environment = process.env }) {
  const settings = normalizeWebSearchSettings(production.settings.modelApi ?? {});
  const deepseekKeyConfigured = controlPlane ? null : Boolean(String(environment.DEEPSEEK_API_KEY ?? '').trim());
  return {
    settings,
    scope: controlPlane ? 'central' : 'local',
    effective: controlPlane ? null : resolveWebSearchConfig(environment, {
      ...settings, doubaoSearchMode: settings.doubaoSearchMode ?? DEFAULT_DOUBAO_SEARCH_MODE,
    }),
    apiKeyConfigured: deepseekKeyConfigured,
    providerKeyConfigured: {
      DEEPSEEK: deepseekKeyConfigured,
      DOUBAO: controlPlane ? null : Boolean(String(environment.DOUBAO_SEARCH_API_KEY ?? '').trim()),
    },
    updatedAt: production.updatedAt ?? null,
  };
}

async function centralProduction(controlPlane) {
  const records = await controlPlane.listSettings();
  const record = records.find((item) => item.key === 'production');
  // The center's seed omits this newer field until Doubao is enabled, so
  // unrelated executors can continue reading its production settings.
  const settings = record?.value ?? { ...DEFAULT_PRODUCTION_SETTINGS,
    modelApi: { ...DEFAULT_PRODUCTION_SETTINGS.modelApi, doubaoSearchMode: null } };
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
    || (settings.modelApi != null && (typeof settings.modelApi !== 'object' || Array.isArray(settings.modelApi)))) {
    throw new TypeError('中心生产配置格式无效，请先修正生产配置 JSON');
  }
  return { settings, version: record?.version ?? null, updatedAt: record?.updatedAt ?? null };
}

export async function readWebSearchSettings(options) {
  const production = options.controlPlane
    ? await centralProduction(options.controlPlane)
    : options.store.getProductionSettings();
  return publicRecord(production, options);
}

export async function updateWebSearchSettings(options, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || Object.keys(patch).length === 0
    || Object.keys(patch).some((key) => !Object.hasOwn(DEFAULT_WEB_SEARCH_SETTINGS, key))) {
    throw new TypeError('只允许修改搜索提供方、备用顺序、模型、超时、来源条数、豆包模式和范围');
  }
  const normalized = normalizeWebSearchSettings(patch);
  const current = options.controlPlane
    ? await centralProduction(options.controlPlane)
    : options.store.getProductionSettings();
  const existing = normalizeWebSearchSettings(current.settings.modelApi ?? {});
  const selected = Object.fromEntries(Object.keys(patch).map((key) => [key, normalized[key]]));
  if (selected.webSearchProviderOrder) {
    selected.webSearchProvider = selected.webSearchProviderOrder[0];
  } else if (Object.hasOwn(patch, 'webSearchProvider') && !Object.hasOwn(patch, 'webSearchProviderOrder')
    && existing.webSearchProviderOrder) {
    // A legacy single-provider PATCH must still take effect after failover has been configured.
    selected.webSearchProviderOrder = null;
  }
  if (!options.controlPlane) {
    const production = options.store.updateProductionSettings({ modelApi: selected });
    return publicRecord(production, options);
  }
  const modelApi = { ...(current.settings.modelApi ?? {}), ...selected };
  // Absent new fields preserve compatibility with older executors until this feature is enabled.
  if (modelApi.webSearchProviderOrder === null) delete modelApi.webSearchProviderOrder;
  if (modelApi.doubaoSearchMode === null) delete modelApi.doubaoSearchMode;
  if (modelApi.doubaoIcpHostOnly === null) delete modelApi.doubaoIcpHostOnly;
  const value = { ...current.settings, modelApi };
  const saved = await options.controlPlane.updateSetting('production', value,
    Number.isSafeInteger(current.version) ? { expectedVersion: current.version } : undefined);
  return publicRecord({ settings: saved.value, updatedAt: saved.updatedAt }, options);
}
