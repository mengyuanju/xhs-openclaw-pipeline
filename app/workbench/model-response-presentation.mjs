const MAX_FORMAT_LENGTH = 50_000;
const MARKDOWN = /(^|\n) {0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|`{3,}|~{3,}|\|)|\*\*[^\n]+\*\*|__[^\n]+__|`[^`\n]+`|\[[^\]\n]+\]\([^\n]+\)/u;

/** Recognize complete structures only; never repair or globally unescape model text. */
export function parseModelResponse(source) {
  if (source.length > MAX_FORMAT_LENGTH) return { format: 'text', value: source };
  const trimmed = source.trim();
  const fence = /^(`{3,}|~{3,})(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\1$/iu.exec(trimmed);
  if (!fence && /^(```|~~~)json\b/iu.test(trimmed)) return { format: 'text', value: source };
  const candidate = fence ? fence[2].trim() : trimmed;
  if (/^[{["]/u.test(candidate)) {
    try {
      const value = JSON.parse(candidate);
      if (value !== null && typeof value === 'object') return { format: 'json', value };
      if (typeof value === 'string') return { format: MARKDOWN.test(value) ? 'markdown' : 'text', value };
    } catch {
      // Broken/truncated JSON stays verbatim, including escapes and surrounding prose.
      if (/^(?:\{|\[\s*[\[{"])/u.test(candidate) || /^(```|~~~)json\b/iu.test(trimmed)) {
        return { format: 'text', value: source };
      }
    }
  }
  return { format: MARKDOWN.test(source) ? 'markdown' : 'text', value: source };
}
