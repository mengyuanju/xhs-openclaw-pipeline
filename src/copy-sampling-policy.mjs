export function normalizeCopySamplingRateOverride(value) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 10000) {
    throw new RangeError('copySamplingRateBpsOverride must be null or an integer between 0 and 10000');
  }
  return value;
}

/** @param {{globalEnabled: boolean, globalRateBps: number, globalPolicyVersion: number,
 * accountRateBpsOverride?: number | null, accountVersion?: number | null}} input */
export function resolveEffectiveCopySamplingPolicy({
  globalEnabled, globalRateBps, globalPolicyVersion,
  accountRateBpsOverride = null, accountVersion = null,
}) {
  if (typeof globalEnabled !== 'boolean') throw new TypeError('globalEnabled must be boolean');
  const override = normalizeCopySamplingRateOverride(accountRateBpsOverride);
  if (!Number.isInteger(globalRateBps) || globalRateBps < 0 || globalRateBps > 10000) {
    throw new RangeError('globalRateBps must be an integer between 0 and 10000');
  }
  return {
    enabled: globalEnabled,
    rateBps: override ?? globalRateBps,
    rateSource: !globalEnabled ? 'GLOBAL_DISABLED' : override === null ? 'GLOBAL_DEFAULT' : 'ACCOUNT_OVERRIDE',
    globalPolicyVersion,
    accountPolicyVersion: accountVersion,
  };
}
