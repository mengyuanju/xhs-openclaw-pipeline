import { apiHandler, ok } from '../_lib';
import { assertRequestSize } from '../../../src/admin/http.mjs';
import { withKnowledgeStore, readKnowledgeModelApi } from '../../../src/admin/knowledge-runtime.mjs';
import { analyzeVisualImage } from '../../../src/admin/visual-knowledge-service.mjs';
import { controlPlaneUrl } from '../../../src/control-plane/next-runtime.mjs';
import { createControlPlaneClient } from '../../../src/control-plane/client.mjs';
import { forwardControlPlaneRequest } from '../../../src/control-plane/next-api-error.mjs';
import { knowledgeActorHeaders } from '../../../src/admin/knowledge-runtime.mjs';
import { withAdminStore, adminOutputRoot } from '../../../src/admin/runtime.mjs';
import { readPromptConfiguration } from '../../../src/admin/prompt-runtime-service.mjs';
import { withPromptExecution } from '../../../src/admin/prompt-execution.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request) {
  return apiHandler(request, { mutation: true, roles: ['ADMIN', 'REVIEWER'] }, async (session) => {
    assertRequestSize(request, 11 * 1024 * 1024);
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new TypeError('请选择需要分析的图片');
    if (file.size > 10 * 1024 * 1024) throw new RangeError('图片不能超过 10 MiB');
    const buffer = Buffer.from(await file.arrayBuffer());
    const center = controlPlaneUrl();
    if (center) {
      const client = createControlPlaneClient({ baseUrl: center, headers: knowledgeActorHeaders(session) });
      return ok(await forwardControlPlaneRequest(() => client.analyzeVisualKnowledge({
        imageBase64: buffer.toString('base64'), mimeType: file.type, fileName: file.name,
      })));
    }
    const configuration = await withAdminStore((store: any) => readPromptConfiguration({ store }));
    const result = await withPromptExecution({ outputRoot: adminOutputRoot(), configuration, kind: 'VISUAL_ANALYSIS', query: file.name }, () => analyzeVisualImage({
      buffer,
      mimeType: file.type,
      fileName: file.name,
      modelApi: configuration.productionSettings.modelApi,
    }));
    return ok(result);
  });
}
