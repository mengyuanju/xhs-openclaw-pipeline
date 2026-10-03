import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROMPT_CATALOG } from '../src/prompt-catalog.mjs';
import { defaultBusinessPrompt, DEFAULT_PROMPT_POLICY } from '../src/prompt-runtime.mjs';
import { previewPrompt } from '../src/admin/prompt-preview.mjs';

test('prompt catalog browser: search, actual defaults, draft editing, readonly contracts and draft retention', {
  skip: process.env.RUN_PROMPT_CATALOG_BROWSER !== '1', timeout: 60_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'prompt-catalog-browser-'));
  const catalog = PROMPT_CATALOG.map(item => ({ ...item, candidate: defaultBusinessPrompt(item.kind) }));
  const kind = 'INTERNAL_EDIT_DIRECT_TEXT';
  const templates = [{ id: 11, kind, name: '直接局部图片编辑', versions: [{ id: 21, version: 1,
    content: '未发布的旧草稿', status: 'DRAFT', createdAt: new Date().toISOString(), publishedAt: null }] }];
  const writes = [], errors = [], recordRequests = [];
  let failRecordLoad = true, failPreview = true;
  let server, browser;
  try {
    await build({ stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { ConfirmDialogProvider } from './components/ui/confirm-dialog';
      import { CentralPromptWorkbench } from './app/prompts/central-prompt-workbench';
      import './app/globals.css';
      createRoot(document.getElementById('root')).render(<ConfirmDialogProvider><CentralPromptWorkbench catalog={${JSON.stringify(catalog)}} /></ConfirmDialogProvider>);
    `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, outfile: join(root, 'bundle.js'), jsx: 'automatic',
      platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() }, define: { 'process.env.NODE_ENV': '"test"' } });
    const [js, rawCss] = await Promise.all([readFile(join(root, 'bundle.js')), readFile(join(root, 'bundle.css'), 'utf8')]);
    const { default: postcss } = await import('postcss'), { default: tailwind } = await import('@tailwindcss/postcss');
    const { css } = await postcss([tailwind()]).process(rawCss, { from: join(process.cwd(), 'app/globals.css') });
    server = createServer(async (req, res) => {
      if (req.url === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); res.end(js); return; }
      if (req.url === '/bundle.css') { res.setHeader('content-type', 'text/css'); res.end(css); return; }
      if (req.url.startsWith('/api/')) {
        let body = ''; for await (const chunk of req) body += chunk;
        let value;
        if (req.url === '/api/prompt-runtime') value = { source: 'CENTER', active: false, settings: DEFAULT_PROMPT_POLICY,
          contract: '程序约束', contractDetails: [], variables: [] };
        else if (req.url === '/api/prompt-runtime/preview') {
          if (failPreview) { failPreview = false; res.statusCode = 503; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: { code: 'FIXTURE', message: '合成预检暂时失败' } })); return; }
          value = previewPrompt(JSON.parse(body), { settings: DEFAULT_PROMPT_POLICY });
        }
        else if (req.url === '/api/control-plane/v1/prompts') value = templates;
        else if (req.url === '/api/control-plane/v1/prompts/versions') {
          const input = JSON.parse(body); writes.push(input);
          value = { id: 22, version: 2, content: input.content, status: 'DRAFT', createdAt: new Date().toISOString(), publishedAt: null };
          let template = templates.find(item => item.kind === input.kind);
          if (!template) { template = { id: 12, kind: input.kind, name: input.name, versions: [] }; templates.push(template); }
          template.versions.unshift(value);
        } else if (req.url.includes('prompt-runs')) {
          const params = new URL(req.url, 'http://localhost').searchParams;
          const source = params.get('source'); recordRequests.push({ source, id: params.get('id') });
          if (failRecordLoad) { failRecordLoad = false; res.statusCode = 503; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: { code: 'FIXTURE', message: '合成执行记录暂时不可读' } })); return; }
          value = params.has('id') ? { id: source+'-run', source, kind: 'TEXT_SYSTEM', query: '<img onerror=window.__promptExecuted=true>', status: 'FAILED', callCount: 1, calls: [{ request: '实际冻结提示词内容 '+source, response: '合成原始响应 '+source, error: '合成模型失败', credential: '[REDACTED]' }] }
            : [{ id: source+'-run', kind: 'TEXT_SYSTEM', query: '合成'+source+'执行', status: 'FAILED', callCount: 1 }];
        }
        else { res.statusCode = 404; value = null; }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: value })); return;
      }
      res.setHeader('content-type', 'text/html');
      res.end('<html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, channel: 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('tab', { name: '文案生成', exact: true }).waitFor();
    const search = page.getByLabel('查找所有提示词');
    await search.fill('直接局部图片编辑');
    await page.getByRole('button', { name: '图片编辑 · 直接局部图片编辑', exact: true }).click();
    const panel = page.locator(`#prompt-panel-${kind}`);
    assert.equal(await panel.getByLabel('提示词内容', { exact: true }).inputValue(), '未发布的旧草稿');
    assert.match(await panel.innerText(), /当前生效来源：系统默认模板/u);
    await panel.getByRole('button', { name: '查看实际默认内容、调用位置和变量', exact: true }).click();
    assert.ok((await panel.innerText()).includes(defaultBusinessPrompt(kind)));
    await panel.getByLabel('提示词内容', { exact: true }).fill('新的局部编辑草稿');
    await search.fill('Codex 文本执行协议');
    await page.getByRole('button', { name: '模型执行协议 · Codex 文本执行协议（只读）', exact: true }).click();
    const protocol = page.locator('#prompt-panel-INTERNAL_CODEX_TEXT_EXECUTION');
    assert.equal(await protocol.getByLabel('提示词内容', { exact: true }).getAttribute('readonly'), '');
    assert.equal(await protocol.getByRole('button', { name: '提交更新', exact: true }).count(), 0);
    await search.fill('直接局部图片编辑');
    await page.getByRole('button', { name: '图片编辑 · 直接局部图片编辑', exact: true }).click();
    assert.equal(await panel.getByLabel('提示词内容', { exact: true }).inputValue(), '新的局部编辑草稿');
    await panel.getByRole('button', { name: '保存草稿', exact: true }).click();
    await panel.getByText('v2', { exact: true }).waitFor();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].kind, kind);
    assert.equal(writes[0].content, '新的局部编辑草稿');
    assert.match(await panel.innerText(), /当前生效来源：系统默认模板/u);
    const guardedKind = 'TEXT_SYSTEM';
    await search.fill(PROMPT_CATALOG.find(item => item.kind === guardedKind).label);
    await page.getByRole('region', { name: '提示词搜索结果', exact: true }).getByRole('button').first().click();
    const guarded = page.locator('#prompt-panel-TEXT_SYSTEM');
    const editor = guarded.getByLabel('提示词内容', { exact: true });
    const guard = guarded.locator('[aria-label="关键提示词优化规则"]');
    await guard.getByText('保护标识完整', { exact: true }).waitFor();
    assert.ok((await guard.innerText()).includes('正文与配图职责分离'));
    const defaultText = await editor.inputValue();
    for (const content of ['合成缺少保护标识的草稿', '【关键优化开始：正文与配图职责分离-V1】【关键优化结束：正文与配图职责分离-V1】', '【关键优化开始：正文与配图职责分离-V1】规则内容但没有结束标识']) {
      await editor.fill(content);
      await guard.getByText('保护标识或规则内容已缺失', { exact: true }).waitFor();
    }
    await guarded.getByRole('button', { name: '保存草稿', exact: true }).click();
    const warning = page.getByRole('alertdialog');
    await warning.getByRole('heading', { name: '关键优化规则可能被删除', exact: true }).waitFor();
    await warning.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(writes.length, 1);
    assert.ok((await editor.inputValue()).includes('没有结束标识'));
    await editor.fill(defaultText);
    await guard.getByText('保护标识完整', { exact: true }).waitFor();
    await editor.fill('合成缺少规则的草稿，仅HTTP夹具，不发布');
    await guarded.getByRole('button', { name: '保存草稿', exact: true }).click();
    await warning.getByRole('button', { name: '仍然保存草稿', exact: true }).click();
    await guarded.getByText('v2', { exact: true }).waitFor();
    assert.equal(writes.length, 2);
    assert.equal(writes[1].kind, guardedKind);
    assert.equal(writes[1].content, '合成缺少规则的草稿，仅HTTP夹具，不发布');
    const concurrentDraft = '合成缺少规则的草稿，仅HTTP夹具，不发布\n当前尚未保存的编辑';
    await editor.fill(concurrentDraft);
    const tabs = page.getByRole('tab');
    await tabs.first().focus(); await tabs.first().press('End'); assert.equal(await tabs.last().getAttribute('aria-selected'), 'true');
    await tabs.last().press('Home'); assert.equal(await tabs.first().getAttribute('aria-selected'), 'true');
    await tabs.first().press('ArrowLeft'); assert.equal(await tabs.last().getAttribute('aria-selected'), 'true');
    await tabs.last().press('ArrowRight'); assert.equal(await tabs.first().getAttribute('aria-selected'), 'true');
    await page.locator('#prompt-tab-TEXT_SYSTEM').click();
    assert.equal(await editor.inputValue(), concurrentDraft);
    templates.find(item => item.kind === guardedKind).versions.unshift({ id: 101, version: 3, content: defaultText+'\n合成其他管理员的新发布版本', status: 'PUBLISHED', createdAt: new Date().toISOString(), publishedAt: new Date().toISOString() });
    const beforeConcurrent = writes.length;
    await page.getByRole('button', { name: '刷新中心数据', exact: true }).click();
    await guarded.getByText('中心已发布版本已变化，当前保留的是你的旧版本修改。请核对历史版本后重新编辑。', { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), concurrentDraft);
    assert.equal(await guarded.getByRole('button', { name: '保存草稿', exact: true }).isDisabled(), true);
    assert.equal(await guarded.getByRole('button', { name: '提交更新', exact: true }).isDisabled(), true);
    assert.equal(writes.length, beforeConcurrent);
    await guarded.getByRole('button', { name: '放弃修改', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改', exact: true }).click();
    assert.equal(await editor.inputValue(), defaultText+'\n合成其他管理员的新发布版本');
    await page.getByRole('button', { name: '编辑 Query 筛选提示词', exact: true }).click(); await page.locator('#prompt-panel-QUERY_REVIEW_SYSTEM').waitFor({ state: 'visible' });
    const queryPanel = page.locator('#prompt-panel-QUERY_REVIEW_SYSTEM');
    await queryPanel.getByRole('button', { name: '对照发布版本与预检草稿', exact: true }).click();
    const example = queryPanel.getByLabel('示例选题', { exact: true }); assert.equal(await example.getAttribute('maxlength'), '500');
    await example.fill('字'.repeat(500)); await example.press('End'); await example.pressSequentially('额'); assert.equal((await example.inputValue()).length, 500);
    const untrustedQuery = '<img onerror=window.__promptExecuted=true> 合成变量展开验证'; await example.fill(untrustedQuery);
    const precheck = queryPanel.getByRole('button', { name: '预检并预览变量展开（不调用模型）', exact: true });
    await precheck.click(); await queryPanel.getByRole('alert').filter({ hasText: '合成预检暂时失败' }).waitFor(); assert.equal(await example.inputValue(), untrustedQuery);
    await precheck.click(); await queryPanel.getByText('仅预览当前模板的变量展开和固定总契约，不调用模型。实际阶段继承规则、任务数据、schema 和工具协议请在执行记录查看。', { exact: true }).waitFor();
    const expanded = await queryPanel.locator('pre').filter({ hasText: '<untrusted_task_data>' }).innerText();
    assert.deepEqual(JSON.parse(expanded.match(/<untrusted_task_data>\s*([\s\S]+?)\s*<\/untrusted_task_data>/)[1]), { query: untrustedQuery, previewOnly: true });
    assert.equal(await page.evaluate(() => window.__promptExecuted), undefined);
    await page.getByRole('button', { name: '查看 Web 执行记录（管理员）', exact: true }).click();
    const refreshRuns = page.getByRole('button', { name: '刷新最近 50 次执行', exact: true });
    await refreshRuns.click(); await page.getByRole('alert').filter({ hasText: '合成执行记录暂时不可读' }).waitFor();
    for (const source of ['WEB', 'CENTER']) {
      if (source === 'CENTER') { await page.getByRole('combobox', { name: '记录位置', exact: true }).click(); await page.getByRole('option', { name: '中心知识分析', exact: true }).click(); assert.equal(await page.getByText(/合成原始响应 WEB/).count(), 0); }
      await refreshRuns.click(); await page.getByRole('button', { name: `TEXT_SYSTEM · 合成${source}执行 · FAILED · 1 次调用`, exact: true }).click();
      await page.waitForFunction(value => [...document.querySelectorAll('pre')].some(element => element.textContent.includes('合成原始响应 '+value)), source);
      const detail = await page.locator('pre').filter({ hasText: '合成原始响应 '+source }).innerText();
      assert.ok(detail.includes('实际冻结提示词内容 '+source)); assert.ok(detail.includes('合成模型失败')); assert.ok(detail.includes('[REDACTED]'));
      assert.equal(await page.evaluate(() => window.__promptExecuted), undefined);
      assert.deepEqual(recordRequests.at(-1), { source, id: source+'-run' });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
