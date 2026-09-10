function deliveryCopyFrom(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const copy = content.copy ?? content.reviewed?.copy ?? content.post ?? content;
  return copy && typeof copy === 'object' && !Array.isArray(copy) ? copy : null;
}

function normalizedAssetId(value) {
  const assetId = Number(value);
  return Number.isSafeInteger(assetId) && assetId > 0 ? assetId : null;
}

export function deliveryCopyFromContent(content) {
  return deliveryCopyFrom(content);
}

/**
 * Resolves the immutable copy and image references used by both READY creation
 * and ZIP generation, so a task cannot enter the delivery pool with a source
 * that the downloader would later reject.
 */
export function resolveDeliveryArchiveSource({ content, imageResult, availableAssetIds }) {
  const copy = deliveryCopyFrom(content);
  if (!copy) throw new TypeError('当前交付文案版本缺失，请刷新后重试');

  const selected = imageResult?.images;
  if (!Array.isArray(selected) || selected.length === 0) {
    throw new TypeError('当前交付图片版本缺失，请刷新后重试');
  }
  const assetIds = selected.map((image) => normalizedAssetId(
    image?.deliveryAssetId ?? image?.assetId,
  ));
  if (assetIds.some((assetId) => assetId === null)) {
    throw new TypeError('当前交付图片资产绑定无效，请重新检查图片版本');
  }

  const available = new Set((availableAssetIds ?? [])
    .map(normalizedAssetId)
    .filter((assetId) => assetId !== null));
  if (assetIds.some((assetId) => !available.has(assetId))) {
    throw new TypeError('交付图片资产缺失，请重新检查图片版本');
  }
  return { copy, assetIds };
}
