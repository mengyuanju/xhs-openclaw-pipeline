import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('central prompt management uses type tabs, editable published content and read-only history', async () => {
  const source = await readFile(new URL('../app/prompts/central-prompt-workbench.tsx', import.meta.url), 'utf8');
  assert.match(source, /role="tablist" aria-label="提示词类型"/u);
  assert.match(source, /role="tabpanel"/u);
  assert.match(source, /ArrowRight/u);
  assert.match(source, /draft\?\.content \?\? published\?\.content/u);
  assert.match(source, /endpoint\('\/v1\/prompts'\), \{ cache: 'no-store' \}/u);
  assert.match(source, /endpoint\('\/v1\/prompts\/versions'\)/u);
  assert.match(source, /endpoint\(`\/v1\/prompt-versions\/\$\{created.id\}\/publish`\)/u);
  assert.match(source, /中心已发布版本发生变化/u);
  assert.match(source, /草稿已保存，但发布未确认成功/u);
  assert.match(source, /<pre className="prompt-history-content">\{version.content\}<\/pre>/u);
  assert.match(source, /载入此版本编辑/u);
  assert.match(source, /切换页签会保留编辑内容/u);
  assert.doesNotMatch(source, /withAdminStore|\/api\/prompts|dangerouslySetInnerHTML/u);
});
