const BASIS_POINTS_PER_PERCENT = 100;
const MAX_RATE_BPS = 10_000;

export function samplingRateBpsFromInput(value: string) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return 0;
  return Math.round(Math.min(100, Math.max(0, percent)) * BASIS_POINTS_PER_PERCENT);
}

export function samplingRateInputValue(rateBps: number, editingValue: string | null) {
  return editingValue ?? Math.min(MAX_RATE_BPS, Math.max(0, rateBps)) / BASIS_POINTS_PER_PERCENT;
}
