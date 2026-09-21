export const DEFAULT_DISCLOSURE_TEXT = '该人物形象由AI生成';
export const DISCLOSURE_HISTORY_STORAGE_KEY = 'xhs.recent-disclosure-texts.v1';
export const MAX_RECENT_DISCLOSURE_TEXTS = 5;

const VALID_DISCLOSURE_TEXT = /^[\p{L}\p{N}_-]{1,12}$/u;

function normalizedText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return VALID_DISCLOSURE_TEXT.test(text) ? text : null;
}

export function normalizeRecentDisclosureTexts(value) {
  if (!Array.isArray(value)) return [];
  const texts = [];
  for (const item of value) {
    const text = normalizedText(item);
    if (!text || texts.includes(text)) continue;
    texts.push(text);
    if (texts.length === MAX_RECENT_DISCLOSURE_TEXTS) break;
  }
  return texts;
}

export function addRecentDisclosureText(history, value) {
  const text = normalizedText(value);
  const current = normalizeRecentDisclosureTexts(history);
  if (!text) return current;
  return [text, ...current.filter((item) => item !== text)]
    .slice(0, MAX_RECENT_DISCLOSURE_TEXTS);
}

export function loadRecentDisclosureTexts(storage) {
  try {
    return normalizeRecentDisclosureTexts(JSON.parse(
      storage.getItem(DISCLOSURE_HISTORY_STORAGE_KEY) || '[]',
    ));
  } catch {
    return [];
  }
}

export function saveRecentDisclosureTexts(storage, history) {
  const normalized = normalizeRecentDisclosureTexts(history);
  try {
    storage.setItem(DISCLOSURE_HISTORY_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // The editor remains usable when browser storage is unavailable or full.
  }
  return normalized;
}
