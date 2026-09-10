const PASSWORD_HASH_ALGORITHM = 'pbkdf2_sha256';
const MIN_PASSWORD_ITERATIONS = 100_000;
const MAX_PASSWORD_ITERATIONS = 2_000_000;

export async function verifyPasswordHash(
  password: string,
  encodedHash: string,
) {
  const [algorithm, iterationValue, saltValue, expectedValue, extra] =
    encodedHash.split('$');
  const iterations = Number(iterationValue);
  if (
    algorithm !== PASSWORD_HASH_ALGORITHM ||
    extra !== undefined ||
    !Number.isInteger(iterations) ||
    iterations < MIN_PASSWORD_ITERATIONS ||
    iterations > MAX_PASSWORD_ITERATIONS
  ) {
    return false;
  }

  try {
    const salt = decodeBase64Url(saltValue);
    const expected = decodeBase64Url(expectedValue);
    if (salt.byteLength < 16 || expected.byteLength !== 32) {
      return false;
    }

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const actual = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          hash: 'SHA-256',
          salt,
          iterations,
        },
        key,
        256,
      ),
    );
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function randomBase64Url(byteLength: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function timingSafeEqualText(left: string, right: string) {
  return timingSafeEqual(
    new TextEncoder().encode(left),
    new TextEncoder().encode(right),
  );
}

function decodeBase64Url(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}
