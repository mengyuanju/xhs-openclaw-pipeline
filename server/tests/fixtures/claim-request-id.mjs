import { randomUUID } from 'node:crypto';

export function requestIdAt(timestamp = Date.now()) {
  const time = timestamp.toString(16).padStart(12, '0');
  const random = randomUUID();
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(15)}`;
}
