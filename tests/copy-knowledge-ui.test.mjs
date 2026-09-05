import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('excellent copy analysis and classification UI', () => {
  it('opens on the copy library while retaining the temporarily hidden knowledge switcher', async () => {
    const [page, promptsPage, tabs, workbench, library] = await Promise.all([
      source('app/knowledge/page.tsx'),
      source('app/prompts/page.tsx'),
      source('app/knowledge/knowledge-tabs.tsx'),
      source('app/knowledge/copy-knowledge-workbench.tsx'),
      source('app/knowledge/copy-knowledge-library.tsx'),
    ]);

    assert.match(page, /<KnowledgeTabs/u);
    assert.match(page, /listCopyKnowledge/u);
    assert.match(page, /listCopyKnowledgeLabels/u);
    assert.doesNotMatch(promptsPage, /CopyKnowledgeWorkbench|listCopyKnowledge/u);
    assert.match(tabs, /SHOW_KNOWLEDGE_TYPE_SWITCHER = false/u);
    assert.match(tabs, /useState<KnowledgeView>\('COPY'\)/u);
    assert.match(tabs, /role="tablist"/u);
    assert.match(tabs, /aria-label="知识库类型"/u);
    assert.match(tabs, />视觉</u);
    assert.match(tabs, />文案</u);
    assert.match(tabs, /role="tabpanel"/u);
    assert.match(workbench, /新增文案分析/u);
    assert.match(workbench, /优秀文案/u);
    assert.match(workbench, /分析 Prompt/u);
    assert.match(workbench, /useState\(''\)/u);
    assert.match(workbench, /<DialogTitle>新增文案分析<\/DialogTitle>/u);
    assert.match(workbench, /<CopyKnowledgeLibrary/u);
    assert.match(library, /按标签查看/u);
    assert.match(library, /placeholder="搜索分析标题"/u);
    assert.match(library, /normalizedSearch\(item\.title\)\.includes\(query\)/u);
    assert.match(library, /新增分析<\/button>/u);
    assert.match(library, /查看<\/button>/u);
    assert.match(library, /删除这条文案分析/u);
    assert.match(library, /method: 'DELETE'/u);
    assert.doesNotMatch(library, /<details className="copy-knowledge-details"/u);
    assert.match(workbench, /\/api\/control-plane\/v1\/copy-knowledge\/analyze/u);
    assert.match(workbench, /AI 分析并直接入库/u);
    assert.doesNotMatch(workbench, /\/api\/copy-analyses/u);
    assert.doesNotMatch(workbench, /\/api\/copy-knowledge-items/u);
    assert.match(library, /编辑<\/button>/u);
    assert.match(library, /保存修改/u);
    assert.match(library, /取消/u);
    assert.match(library, /method:\s*'PATCH'/u);
    assert.match(library, /\/api\/copy-knowledge-items\/\$\{item\.id\}/u);
  });

  it('delegates analysis and direct persistence exclusively to the control plane', async () => {
    const [workbench, centerService, centerHttp] = await Promise.all([
      source('app/knowledge/copy-knowledge-workbench.tsx'),
      source('server/src/deepseek-copy-analysis.mjs'),
      source('server/src/http-server.mjs'),
    ]);
    assert.match(workbench, /copy-knowledge\/analyze/u);
    assert.match(centerHttp, /router\.post\('\/v1\/copy-knowledge\/analyze'/u);
    assert.match(centerHttp, /requestActor\(ctx, \['ADMIN', 'REVIEWER'\]\)/u);
    assert.match(centerService, /DEEPSEEK_API_KEY/u);
    assert.match(centerService, /deepseek-v4-pro/u);
    assert.match(centerService, /repository\.createKnowledgeVersion/u);
    assert.match(centerService, /publish: true/u);
    assert.doesNotMatch(workbench, /检查分析结果|按标签保存到知识库/u);
    const legacyRoute = await source('app/api/copy-analyses/route.ts');
    assert.match(legacyRoute, /status: 308/u);
    assert.match(legacyRoute, /copy-knowledge\/analyze/u);
    assert.doesNotMatch(legacyRoute, /analyzeExcellentCopy|createOpenClawClient/u);
  });

  it('validates saved-copy edits through a strict bounded PATCH endpoint', async () => {
    const updateRoute = await source('app/api/copy-knowledge-items/[id]/route.ts');

    assert.match(updateRoute, /export async function PATCH/u);
    assert.match(updateRoute, /apiHandler\(request, \{ mutation: true, roles: \['ADMIN', 'REVIEWER'\] \}/u);
    assert.match(updateRoute, /parsePositiveId/u);
    assert.match(updateRoute, /\.strict\(\)/u);
    assert.match(updateRoute, /sourceCopy/u);
    assert.match(updateRoute, /analysisPrompt/u);
    assert.match(updateRoute, /labels:\s*z\.array/u);
    assert.match(updateRoute, /\.min\(1\)\.max\(12\)/u);
    assert.match(updateRoute, /maxBytes:\s*192 \* 1024/u);
    assert.match(updateRoute, /notFound\('文案知识不存在'\)/u);
    assert.match(updateRoute, /export async function DELETE/u);
    assert.match(updateRoute, /store\.deleteCopyKnowledge\(id\)/u);
  });
});
