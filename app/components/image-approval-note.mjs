export function imageApprovalNoteForVersion(
  events,
  imageRunId,
  copyRevisionId,
) {
  if (!Array.isArray(events) || !imageRunId || !Number.isSafeInteger(copyRevisionId)
      || (copyRevisionId ?? 0) < 1) return null;
  const matching = events.filter((value) => value && typeof value === 'object'
    && !Array.isArray(value) && value.imageRunId === imageRunId
    && value.copyRevisionId === copyRevisionId);
  const event = matching.toSorted((left, right) => {
    const submittedAt = (value) => {
      const time = Date.parse(value.submittedAt);
      return Number.isFinite(time) ? time : 0;
    };
    const id = (value) => Number.isSafeInteger(Number(value.id)) ? Number(value.id) : 0;
    return submittedAt(right) - submittedAt(left) || id(right) - id(left);
  })[0];
  return typeof event?.manualModificationNote === 'string'
    ? event.manualModificationNote.trim() || null : null;
}
