import { normalizePersonalFilters } from '../../src/personal-workspace.mjs';

export type PersonalOptions = {
  mode: string; period: string; from: string; to: string; stage: string;
  reworkType: string; reworkProgress: string; reworkSource: string;
  longWaiting: string; repeated: string; qualityFirst: string; createdFrom: string; createdTo: string;
};
export const DEFAULT_PERSONAL_OPTIONS: PersonalOptions = {
  mode: 'CURRENT', period: 'today', from: '', to: '', stage: '', reworkType: '',
  reworkProgress: '', reworkSource: '', longWaiting: '', repeated: '', qualityFirst: '', createdFrom: '', createdTo: '',
};
export function parsePersonalOptions(input: Record<string, string | string[] | undefined>): PersonalOptions {
  let filters;
  try { filters = normalizePersonalFilters(input); }
  catch { filters = normalizePersonalFilters({ ...input, period: 'today' }); }
  return { ...DEFAULT_PERSONAL_OPTIONS, mode: filters.mode, period: filters.range.period,
    from: filters.range.period === 'custom' ? filters.range.from : '', to: filters.range.period === 'custom' ? filters.range.to : '',
    stage: filters.stage, reworkType: filters.reworkType, reworkProgress: filters.reworkProgress, reworkSource: filters.reworkSource,
    longWaiting: filters.longWaiting ? '1' : '', repeated: filters.repeated ? '1' : '', qualityFirst: filters.qualityFirst ? '1' : '',
    createdFrom: filters.createdFrom, createdTo: filters.createdTo };
}
export function appendPersonalOptions(search: URLSearchParams, options: PersonalOptions) {
  for (const [key, value] of Object.entries(options)) {
    if (value && value !== DEFAULT_PERSONAL_OPTIONS[key as keyof PersonalOptions]) search.set(key, value);
    else search.delete(key);
  }
  return search;
}
export type PersonalWork = {
  categories: string[]; reworkType: string | null; reworkProgress: string | null;
  reworkSource: string | null; waitingHours: number | null; waitingSince: string | null;
  returnedAt: string | null; returnNote: string | null; reworkCount: number;
  planStatus: string | null; imageEdits: { queued: number; running: number; ready: number; failed: number };
};
export type PersonalEvent = { id: string; kind: string; stage: string; at: string; rework: boolean; passed: boolean };
