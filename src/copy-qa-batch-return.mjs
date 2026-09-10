function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function opaqueId(value, label) {
  if (typeof value !== 'string' || value.trim().length < 8) throw new TypeError(`${label} is invalid`);
  return value.trim();
}

export function copyQaBatchPreviewItemIds(preview) {
  const row = record(preview);
  if (!row || !Array.isArray(row.items)) return [];
  return row.items.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim().length >= 8) return [entry.trim()];
    const item = record(entry);
    return typeof item?.id === 'string' && item.id.trim().length >= 8 ? [item.id.trim()] : [];
  });
}

/**
 * Binds a batch-return mutation to the freshly fetched server preview. The
 * trigger may already be RETURNED; it is intentionally independent from the
 * currently visible PENDING queue.
 */
export function buildCopyQaBatchReturnPayload({
  freezePublicId,
  triggerSamplingItemId,
  preview,
  reasonCodes,
  note,
  requestId,
}) {
  const previewRow = record(preview);
  const confirmedCount = Number(previewRow?.confirmedCount);
  const itemIds = copyQaBatchPreviewItemIds(preview);
  if (!Number.isSafeInteger(confirmedCount) || confirmedCount < 1
      || itemIds.length !== confirmedCount || new Set(itemIds).size !== itemIds.length) {
    throw new TypeError('batch preview scope is invalid');
  }
  return {
    freezePublicId: opaqueId(freezePublicId, 'freezePublicId'),
    triggerSamplingItemId: opaqueId(triggerSamplingItemId, 'triggerSamplingItemId'),
    itemIds,
    reasonCodes: Array.isArray(reasonCodes) ? [...reasonCodes] : [],
    note: String(note ?? '').trim(),
    confirmedCount,
    requestId: opaqueId(requestId, 'requestId'),
  };
}
