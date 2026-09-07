import { apiHandler, ok } from '../_lib';
import { adminOutputRoot } from '../../../src/admin/runtime.mjs';
import { listPromptExecutions, readPromptExecution } from '../../../src/admin/prompt-execution.mjs';
import { withPromptStore } from '../_prompt-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return apiHandler(request, { roles: ['ADMIN'] }, async (session) => {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (url.searchParams.get('source') === 'CENTER') {
      return withPromptStore(session, async ({ controlPlane }: any) => {
        if (!controlPlane) throw new TypeError('当前未配置中心服务');
        return ok(await controlPlane.listPromptRuns(id));
      });
    }
    return ok(id ? await readPromptExecution(adminOutputRoot(), id) : await listPromptExecutions(adminOutputRoot()));
  });
}
