import { createControlPlaneClient } from '../../src/control-plane/client.mjs';
import { controlPlaneUrl } from '../../src/control-plane/next-runtime.mjs';
import { withAdminStore } from '../../src/admin/runtime.mjs';
import { assertAuthorizedSession } from '../../src/admin/http.mjs';
import { readPromptConfiguration } from '../../src/admin/prompt-runtime-service.mjs';
import { forwardControlPlaneRequest } from '../../src/control-plane/next-api-error.mjs';
import { sessionActorHeaders } from '../../src/control-plane/session-actor-headers.mjs';

export function withPromptStore<T>(session: any, action: (options: any) => T | Promise<T>): T | Promise<T> {
  assertAuthorizedSession(session, ['ADMIN']);
  const root = controlPlaneUrl();
  if (!root) return withAdminStore((store: any) => action({ store }));
  const controlPlane = createControlPlaneClient({
    baseUrl: root,
    headers: sessionActorHeaders(session, {
      username: session.username || session.subject,
      role: 'ADMIN',
    }),
  });
  return forwardControlPlaneRequest(() => action({ controlPlane }));
}

export async function loadPromptConfiguration(session: any) {
  return withPromptStore(session, readPromptConfiguration);
}
