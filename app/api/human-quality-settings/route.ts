import { z } from 'zod';

import { apiHandler, ok, parseJson } from '../_lib';
import { ApiError } from '../../../src/admin/http.mjs';
import { withAdminStore } from '../../../src/admin/runtime.mjs';
import { ControlPlaneApiError, createControlPlaneClient } from '../../../src/control-plane/client.mjs';
import { controlPlaneUrl } from '../../../src/control-plane/next-runtime.mjs';
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
    headers: {
      'X-Actor-Username': username,
      'X-Actor-Role': role,
      'X-Actor-Credential-Version': String(session.credentialVersion || 1),
    },
  });
}

async function forwardControlPlane<T>(request: () => Promise<T>) {
  try {
    return await request();
  } catch (error) {
    if (error instanceof ControlPlaneApiError) {
      throw new ApiError(error.status, error.code, error.message);
    }
    throw error;
  }
}

async function readSettings(session: Session) {
  const client = centralClient(session);
  if (client) return forwardControlPlane(() => client.getHumanQualitySettings());
  return withAdminStore((store: any) => normalizeHumanQualitySettings(
    store.getProductionSettings().settings.humanQualityReasons,
  ));
}

async function updateSettings(session: Session, input: unknown) {
  const settings = normalizeHumanQualitySettingsUpdate(input);
  const client = centralClient(session);
  if (client) return forwardControlPlane(() => client.updateHumanQualitySettings(settings));
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
