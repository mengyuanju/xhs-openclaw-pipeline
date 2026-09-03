import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('excellent copy analysis and classification UI', () => {
  it('places the module in the unified knowledge page with accessible visual and copy tabs', async () => {
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
    assert.match(tabs, /role="tablist"/u);
    assert.match(tabs, /aria-label="知识库类型"/u);
    assert.match(tabs, />视觉</u);
    assert.match(tabs, />文案</u);
    assert.match(tabs, /role="tabpanel"/u);
    assert.match(workbench, /优秀文案分析与分类/u);
    assert.match(workbench, /优秀文案/u);
    assert.match(workbench, /分析 Prompt/u);
    assert.match(workbench, /useState\(''\)/u);
    assert.match(workbench, /<CopyKnowledgeLibrary/u);
    assert.match(library, /按标签查看/u);
    assert.match(workbench, /\/api\/copy-analyses/u);
    assert.match(workbench, /\/api\/copy-knowledge-items/u);
    assert.match(library, /编辑已保存内容/u);
    assert.match(library, /保存修改/u);
    assert.match(library, /取消/u);
    assert.match(library, /method:\s*'PATCH'/u);
    assert.match(library, /\/api\/copy-knowledge-items\/\$\{item\.id\}/u);
  });

  it('validates both mutation endpoints with strict bounded schemas', async () => {
    const [analysisRoute, storageRoute] = await Promise.all([
      source('app/api/copy-analyses/route.ts'),
      source('app/api/copy-knowledge-items/route.ts'),
    ]);

    for (const route of [analysisRoute, storageRoute]) {
      assert.match(route, /apiHandler\(request, \{ mutation: true \}/u);
      assert.match(route, /\.strict\(\)/u);
      assert.match(route, /parseJson/u);
    }
    assert.match(analysisRoute, /sourceCopy/u);
    assert.match(analysisRoute, /analysisPrompt/u);
    assert.match(analysisRoute, /maxBytes:\s*128 \* 1024/u);
    assert.match(storageRoute, /labels:\s*z\.array/u);
    assert.match(storageRoute, /\.min\(1\)\.max\(12\)/u);
    assert.match(storageRoute, /maxBytes:\s*192 \* 1024/u);
  });

  it('validates saved-copy edits through a strict bounded PATCH endpoint', async () => {
    const updateRoute = await source('app/api/copy-knowledge-items/[id]/route.ts');

    assert.match(updateRoute, /export async function PATCH/u);
    assert.match(updateRoute, /apiHandler\(request, \{ mutation: true \}/u);
    assert.match(updateRoute, /parsePositiveId/u);
    assert.match(updateRoute, /\.strict\(\)/u);
    assert.match(updateRoute, /sourceCopy/u);
    assert.match(updateRoute, /analysisPrompt/u);
    assert.match(updateRoute, /labels:\s*z\.array/u);
    assert.match(updateRoute, /\.min\(1\)\.max\(12\)/u);
    assert.match(updateRoute, /maxBytes:\s*192 \* 1024/u);
    assert.match(updateRoute, /notFound\('文案知识不存在'\)/u);
  });
});
