export function canCommitLatestRequest(
  activeRequestId: number,
  completedRequestId: number,
  aborted = false,
) {
  return !aborted && activeRequestId === completedRequestId;
}
