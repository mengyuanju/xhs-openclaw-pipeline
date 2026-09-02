type RunIdCrypto = {
  randomUUID?: () => string;
  getRandomValues?: (values: Uint8Array) => Uint8Array;
};

const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));

function formatUuid(bytes: Uint8Array) {
  const hex = Array.from(bytes, (value) => HEX[value]);
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

export function createRunId(
  cryptoSource: RunIdCrypto | null | undefined = globalThis.crypto,
  randomSource: () => number = Math.random,
) {
  if (typeof cryptoSource?.randomUUID === 'function') {
    return cryptoSource.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof cryptoSource?.getRandomValues === 'function') {
    cryptoSource.getRandomValues(bytes);
  } else {
    // The run ID correlates progress only; it is never used as a credential.
    bytes.forEach((_, index) => {
      bytes[index] = Math.floor(randomSource() * 256);
    });
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}
