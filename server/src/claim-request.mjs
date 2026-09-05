import { ControlPlaneConflictError, normalizeUuid } from './domain.mjs';

export function claimRequestExpiry(requestId, now = Date.now()) {
  const id = normalizeUuid(requestId, 'requestId');
  if (id[14] !== '7') throw new TypeError('batch requestId must be UUIDv7');
  const issuedAt = Number.parseInt(id.slice(0, 13).replace('-', ''), 16);
  if (issuedAt > now + 300_000) {
    throw new ControlPlaneConflictError('CLAIM_REQUEST_CLOCK_SKEW', 'executor clock is ahead of the center; synchronize the system clocks');
  }
  const expiresAt = issuedAt + 86_400_000;
  if (expiresAt <= now) {
    throw new ControlPlaneConflictError('CLAIM_REQUEST_EXPIRED', 'claim request expired and has no running executions; use a new requestId');
  }
  return new Date(expiresAt);
}
