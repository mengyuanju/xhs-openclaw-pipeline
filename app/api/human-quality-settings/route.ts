import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import { withAdminStore } from '../../../src/admin/runtime.mjs';
import { createControlPlaneClient } from '../../../src/control-plane/client.mjs';
import { forwardControlPlaneRequest } from '../../../src/control-plane/next-api-error.mjs';
import { controlPlaneUrl } from '../../../src/control-plane/next-runtime.mjs';
import { sessionActorHeaders } from '../../../src/control-plane/session-actor-headers.mjs';
import {
  normalizeHumanQualitySettings,
  normalizeHumanQualitySettingsUpdate,
} from '../../../src/human-quality-settings.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const settingsSchema = z.unknown().transform((value, context) => {
  try {
    return normalizeHumanQualitySettingsUpdate(value);
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : '人工评分原因配置无效',
    });
    return z.NEVER;
  }
});

type Session = {
  subject: string;
  userId?: number;
  username?: string;
  roles: string[];
  credentialVersion?: number;
};

function centralClient(session: Session) {
  const baseUrl = controlPlaneUrl();
  if (!baseUrl) return null;
  const username = session.username || (session.subject === 'admin' ? 'admin' : '');
  const role = session.roles[0];
  return createControlPlaneClient({
    baseUrl,
    headers: sessionActorHeaders(session, { username, role }),
  });
}

async function readSettings(session: Session) {
  const client = centralClient(session);
  if (client) return forwardControlPlaneRequest(() => client.getHumanQualitySettings());
  return withAdminStore((store: any) => normalizeHumanQualitySettings(
    store.getProductionSettings().settings.humanQualityReasons,
  ));
}

async function updateSettings(session: Session, input: unknown) {
  const settings = normalizeHumanQualitySettingsUpdate(input);
  const client = centralClient(session);
  if (client) return forwardControlPlaneRequest(() => client.updateHumanQualitySettings(settings));
  return withAdminStore((store: any) => store.updateProductionSettings({
    humanQualityReasons: settings,
  }).settings.humanQualityReasons);
}

export function GET(request: Request) {
  return apiHandler(request, { roles: ['ADMIN', 'REVIEWER', 'USER'] }, async (session) => ok(
    await readSettings(session as Session),
  ));
}

export async function PUT(request: Request) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN'] }, async (session) => ok(
    await updateSettings(session as Session, await parseJson(request, settingsSchema, { maxBytes: 16 * 1024 })),
  ));
}
