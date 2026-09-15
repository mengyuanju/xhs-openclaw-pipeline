export function isLegacyTaskStateFilterError(error: unknown) {
  if (!(error instanceof Error) || error.name !== 'ApiRequestError') return false;
  const apiError = error as Error & { status?: unknown; code?: unknown };
  return apiError.status === 400
    && apiError.code === 'VALIDATION_ERROR'
    && error.message.startsWith('task state filter is invalid');
}
