export function sessionActorHeaders(session, { username, role } = {}) {
  const resolvedUsername = username ?? session?.username
    ?? (session?.subject === 'admin' ? 'admin' : '');
  const resolvedRole = role ?? (session?.subject === 'admin' ? 'ADMIN' : session?.roles?.[0] ?? '');
  return {
    'X-Actor-User-Id': String(session?.userId ?? ''),
    'X-Actor-Username': resolvedUsername,
    'X-Actor-Role': resolvedRole,
    'X-Actor-Credential-Version': String(session?.credentialVersion || 1),
  };
}
