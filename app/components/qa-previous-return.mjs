function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function boundedText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && [...text].length <= maxLength ? text : null;
}

function stringList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, maxItems).flatMap(item => {
    const text = boundedText(item, maxLength);
    return text ? [text] : [];
  }))];
}

export function normalizeQaPreviousReturn(value) {
  const row = record(value);
  if (!row) return null;
  return {
    reasonLabels: stringList(row.reasonLabels, 20, 100),
    note: boundedText(row.note, 2000),
    returnedAt: boundedText(row.returnedAt, 40),
  };
}

export function normalizeImageQaPreviousReturn(value) {
  const row = record(value);
  const common = normalizeQaPreviousReturn(value);
  if (!row || !common) return null;
  return {
    ...common,
    reworkTarget: ['IMAGE', 'COPY', 'BOTH'].includes(String(row.reworkTarget)) ? row.reworkTarget : null,
    problemPages: Array.isArray(row.problemPages)
      ? [...new Set(row.problemPages.filter(page => Number.isSafeInteger(page) && page > 0 && page <= 100))].slice(0, 100).sort((a, b) => a - b)
      : [],
    copyFields: stringList(row.copyFields, 10, 40),
  };
}
