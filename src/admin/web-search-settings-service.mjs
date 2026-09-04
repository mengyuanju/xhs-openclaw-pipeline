import { DEFAULT_PRODUCTION_SETTINGS } from '../production-settings.mjs';
import { DEFAULT_WEB_SEARCH_SETTINGS, normalizeWebSearchSettings, resolveWebSearchConfig } from '../web-search-config.mjs';

function publicRecord(production, { controlPlane, environment = process.env }) {
  const settings = normalizeWebSearchSettings(production.settings.modelApi ?? {});
  return {
    settings,
    scope: controlPlane ? 'central' : 'local',
    effective: controlPlane ? null : resolveWebSearchConfig(environment, settings),
    apiKeyConfigured: controlPlane ? null : Boolean(environment.DEEPSEEK_API_KEY?.trim()),
    updatedAt: production.updatedAt ?? null,
  };
}

async function centralProduction(controlPlane) {
  const records = await controlPlane.listSettings();
  const record = records.find((item) => item.key === 'production');
  const settings = record?.value ?? DEFAULT_PRODUCTION_SETTINGS;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
    || (settings.modelApi != null && (typeof settings.modelApi !== 'object' || Array.isArray(settings.modelApi)))) {
    throw new TypeError('中心生产配置格式无效，请先修正生产配置 JSON');
  }
  return { settings, updatedAt: record?.updatedAt ?? null };
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
    throw new TypeError('只允许修改搜索提供方、模型和超时');
  }
  const normalized = normalizeWebSearchSettings(patch);
  const selected = Object.fromEntries(Object.keys(patch).map((key) => [key, normalized[key]]));
  if (!options.controlPlane) {
    const production = options.store.updateProductionSettings({ modelApi: selected });
    return publicRecord(production, options);
  }
  const current = await centralProduction(options.controlPlane);
  const value = { ...current.settings, modelApi: { ...current.settings.modelApi, ...selected } };
  const saved = await options.controlPlane.updateSetting('production', value);
  return publicRecord({ settings: saved.value, updatedAt: saved.updatedAt }, options);
}
