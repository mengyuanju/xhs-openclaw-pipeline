import { createControlPlaneClient } from '../../src/control-plane/client.mjs';
import { controlPlaneUrl } from '../../src/control-plane/next-runtime.mjs';
import { withAdminStore } from '../../src/admin/runtime.mjs';
import { assertAuthorizedSession } from '../../src/admin/http.mjs';
import { readPromptConfiguration } from '../../src/admin/prompt-runtime-service.mjs';

export function withPromptStore<T>(session: any, action: (options: any) => T | Promise<T>): T | Promise<T> {
  assertAuthorizedSession(session, ['ADMIN']);
  const root = controlPlaneUrl();
  if (!root) return withAdminStore((store: any) => action({ store }));
  const controlPlane = createControlPlaneClient({ baseUrl: root, headers: {
    'X-Actor-Username': session.username || session.subject,
    'X-Actor-Role': 'ADMIN',
    'X-Actor-Credential-Version': String(session.credentialVersion || 1),
  } });
  return action({ controlPlane });
}

export async function loadPromptConfiguration(session: any) {
  return withPromptStore(session, readPromptConfiguration);
}
