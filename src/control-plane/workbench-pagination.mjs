/** @param {number} total @param {number} pageSize @param {number} requestedPage */
export function paginationBounds(total, pageSize, requestedPage) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, Math.max(1, requestedPage));
  const offset = (page - 1) * pageSize;
  return { page, totalPages, offset, start: total ? offset + 1 : 0, end: Math.min(offset + pageSize, total) };
}

/** @param {string} value @param {number} totalPages */
export function parsePageNumber(value, totalPages) {
  const text = value.trim();
  if (!/^\d+$/u.test(text)) return null;
  const page = Number(text);
  return Number.isSafeInteger(page) && page >= 1 && page <= totalPages ? page : null;
}
