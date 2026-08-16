const AUTH_KEYS = Object.freeze({
  XHS_ADMIN_PASSWORD_HASH: 'passwordHash',
  XHS_SESSION_SECRET: 'sessionSecret',
});

function assertSafeEnvironmentValue(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new TypeError('authentication environment value is invalid');
  }
}

export function updateAuthEnvironmentFile(content, { passwordHash, sessionSecret }) {
  if (typeof content !== 'string') throw new TypeError('environment file content must be text');
  assertSafeEnvironmentValue(passwordHash);
  assertSafeEnvironmentValue(sessionSecret);

  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.length > 0 ? content.replaceAll('\r\n', '\n').split('\n') : [];
  const replacements = {
    XHS_ADMIN_PASSWORD_HASH: passwordHash,
    XHS_SESSION_SECRET: sessionSecret,
  };
  const seen = new Set();
  const output = [];

  for (const line of lines) {
    const match = line.match(/^\s*(XHS_ADMIN_PASSWORD_HASH|XHS_SESSION_SECRET)\s*=/);
    if (!match) {
      output.push(line);
      continue;
    }
    const key = match[1];
    if (!seen.has(key)) output.push(`${key}=${replacements[key]}`);
    seen.add(key);
  }

  while (output.at(-1) === '') output.pop();
  for (const key of Object.keys(AUTH_KEYS)) {
    if (!seen.has(key)) output.push(`${key}=${replacements[key]}`);
  }
  return `${output.join(lineEnding)}${lineEnding}`;
}
