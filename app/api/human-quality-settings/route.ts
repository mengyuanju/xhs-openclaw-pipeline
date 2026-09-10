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

const settingsSchema = z.object({
  scoreDefinitions: z.unknown().optional(),
  copyReasons: z.unknown(),
  imageReasons: z.unknown(),
  noteGuidance: z.unknown().optional(),
  copyReviewDisplay: z.object({
    showScoreDescriptions: z.boolean(),
    showDeductionReasons: z.boolean(),
  }).strict().optional(),
}).strict();

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
  if (client) return normalizeHumanQualitySettings(
    await forwardControlPlaneRequest(() => client.getHumanQualitySettings()),
  );
  return withAdminStore((store: any) => normalizeHumanQualitySettings(
    store.getProductionSettings().settings.humanQualityReasons,
  ));
}

async function updateSettings(session: Session, input: unknown) {
  const client = centralClient(session);
  if (client) return normalizeHumanQualitySettings(
    await forwardControlPlaneRequest(() => client.updateHumanQualitySettings(input)),
  );
  return withAdminStore((store: any) => {
    const current = normalizeHumanQualitySettings(
      store.getProductionSettings().settings.humanQualityReasons,
    );
    const settings = normalizeHumanQualitySettingsUpdate(input, current);
    return store.updateProductionSettings({
      humanQualityReasons: settings,
    }).settings.humanQualityReasons;
  });
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
