import { randomBytes } from 'node:crypto';

// RFC 9562 section 5.7: timestamp is bound to identity, so an expired request
// cannot become a fresh claim after its terminal receipt has been removed.
export function createClaimRequestId(timestamp = Date.now()) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
    throw new RangeError('claim timestamp is outside the UUIDv7 range');
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(timestamp, 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
