/** Integer arithmetic; the saved remainder belongs to one stable account only.
 * Closing a nonempty tail adds one safety sample without spending future quota.
 */
export function planCopyQualityChunk({ count, rateBps, remainder = 0, close = false }) {
  if (!Number.isSafeInteger(count) || count < 0
      || !Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000
      || !Number.isInteger(remainder) || remainder < 0 || remainder >= 10000) {
    throw new RangeError('invalid copy sampling count, rate or remainder');
  }
  if (!count) return { memberCount: 0, sampleCount: 0, remainder };
  const needed = rateBps ? Math.ceil((10000 - remainder) / rateBps) : Infinity;
  if (!close && count < needed) return { memberCount: 0, sampleCount: 0, remainder };
  const memberCount = close ? count : needed;
  const numerator = remainder + memberCount * rateBps;
  return { memberCount, sampleCount: Math.min(memberCount,
    Math.floor(numerator / 10000) + (close && numerator % 10000 > 0 ? 1 : 0) || 1),
  remainder: numerator % 10000 };
}

export function copyQualityImageGate(alias) {
  if (!['task', 'queued'].includes(alias)) throw new TypeError('invalid task alias');
  return `(${alias}.copy_qc_released_revision_id = ${alias}.current_copy_revision_id AND copy_quality_image_eligible(${alias}.id, ${alias}.current_copy_revision_id, ${alias}.mandatory_copy_qc))`;
}
