function cleanReasons(reasons) {
  return Array.isArray(reasons) ? [...reasons] : [];
}

/**
 * Builds the copy-review mutation without conflating the AI draft assessment
 * with the final approved human revision.
 */
export function buildCopyReviewSubmission({
  revisionId,
  nodeId,
  decision,
  draft,
  draftChanged,
  copyContentChanged,
  copyContentChangedFromMachine,
  copyRework = false,
  originalScore,
  originalReasons,
  originalNote,
  aiDisclosureEnabled,
}) {
  const approvingEditedRevision = decision === 'APPROVE'
    && (copyContentChanged === true || copyContentChangedFromMachine === true);
  const approvingRework = decision === 'APPROVE' && copyRework === true;
  if (decision === 'APPROVE' && copyRework !== true) {
    if (originalScore === 1) {
      throw new RangeError('a machine draft scored 1 must be discarded');
    }
    if ((originalScore === 2 || originalScore === 2.5) && !approvingEditedRevision) {
      throw new RangeError('a machine draft scored 2 or 2.5 must be genuinely edited before approval');
    }
    if (originalScore !== 2 && originalScore !== 2.5 && originalScore !== 3) {
      throw new TypeError('an approval requires a valid machine-draft score');
    }
  }
  const finalScore = approvingEditedRevision || approvingRework ? 3 : originalScore;
  const includesRating = copyRework !== true || decision === 'APPROVE';
  const preservesOriginalAssessment = decision !== 'DISCARD'
    && copyRework !== true
    && originalScore !== null && originalScore !== undefined
    && (copyContentChanged === true || copyContentChangedFromMachine === true);

  return {
    revisionId,
    nodeId,
    decision,
    ...(includesRating ? {
      score: finalScore,
      reasons: finalScore === 3 ? [] : cleanReasons(originalReasons),
      note: finalScore === 3 ? '' : String(originalNote ?? '').trim(),
    } : {}),
    ...(decision !== 'DISCARD' && draftChanged ? { edits: draft } : {}),
    ...(preservesOriginalAssessment ? {
      originalScore,
      originalReasons: cleanReasons(originalReasons),
      originalNote: String(originalNote ?? ''),
    } : {}),
    aiDisclosureEnabled: aiDisclosureEnabled === true,
  };
}
