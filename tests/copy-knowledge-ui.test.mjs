import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('excellent copy analysis and classification UI', () => {
  it('adds the module to the prompt page with empty authoring fields and label filtering', async () => {
    const [page, workbench, library] = await Promise.all([
      source('app/prompts/page.tsx'),
      source('app/prompts/copy-knowledge-workbench.tsx'),
      source('app/prompts/copy-knowledge-library.tsx'),
    ]);

    assert.match(page, /<CopyKnowledgeWorkbench/u);
    assert.match(page, /listCopyKnowledge/u);
    assert.match(page, /listCopyKnowledgeLabels/u);
    assert.match(workbench, /优秀文案分析与分类/u);
    assert.match(workbench, /优秀文案/u);
    assert.match(workbench, /分析 Prompt/u);
    assert.match(workbench, /useState\(''\)/u);
    assert.match(workbench, /<CopyKnowledgeLibrary/u);
    assert.match(library, /按标签查看/u);
    assert.match(workbench, /\/api\/copy-analyses/u);
    assert.match(workbench, /\/api\/copy-knowledge-items/u);
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
});
