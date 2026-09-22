import { resolveEffectiveCopySamplingPolicy } from '../../src/copy-sampling-policy.mjs';

export type AccountSamplingSettings = { supported: boolean; enabled: boolean; rateBps: number; version: number };

export function accountSamplingSettings(health: any, settings: any): AccountSamplingSettings | null {
  if (typeof settings?.copySampling?.enabled !== 'boolean'
      || !Number.isInteger(settings.copySampling.rateBps)
      || settings.copySampling.rateBps < 0 || settings.copySampling.rateBps > 10000
      || !Number.isSafeInteger(settings.version) || settings.version < 1) return null;
  const version = health?.capabilities?.copySamplingVersion;
  return {
    supported: Number.isInteger(version) && version >= 2,
    enabled: settings.copySampling.enabled,
    rateBps: settings.copySampling.rateBps,
    version: settings.version,
  };
}

export function accountSamplingLabel(settings: AccountSamplingSettings | null, override: number | null | undefined) {
  if (!settings) return '配置暂不可用';
  if (!settings.supported) return '中心服务尚未支持账号级比例';
  if (override === undefined) return '账号比例未读取，请刷新';
  const policy = resolveEffectiveCopySamplingPolicy({
    globalEnabled: settings.enabled, globalRateBps: settings.rateBps, globalPolicyVersion: settings.version,
    accountRateBpsOverride: override,
  });
  return `${override === null ? '继承' : '单独'} · ${policy.rateBps / 100}%${policy.rateBps === 0 ? '（尾批保底）' : ''}${policy.enabled ? '' : ' · 暂不生效'}`;
}

export function accountSamplingInputBps(input: string) {
  if (!/^\d+(?:\.\d{1,2})?$/u.test(input.trim())) throw new Error('请输入 0–100 的比例，最多两位小数');
  const bps = Math.round(Number(input) * 100);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new Error('文案抽检比例必须在 0–100% 之间');
  return bps;
}
