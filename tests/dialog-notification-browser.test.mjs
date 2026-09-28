import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('dialog and notification browser: independent message interactions and nested system dialogs', {
  skip: process.env.RUN_DIALOG_NOTIFICATION_BROWSER !== '1', timeout: 90_000,
}, async (t) => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const { default: postcss } = await import('postcss');
  const { default: tailwind } = await import('@tailwindcss/postcss');
  const directory = await mkdtemp(join(tmpdir(), 'dialog-notification-browser-'));
  let browser, server;
  const browserErrors = [], unexpectedRequests = [];
  try {
    await build({
      stdin: {
        contents: `
          import './app/globals.css';
          import React, { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { toast } from 'sonner';
          import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog';
          import { TextInputDialogProvider, useTextInputDialog } from './components/ui/text-input-dialog';
          import { Toaster } from './components/ui/sonner';
          import editorStyles from './app/components/current-image-editor.module.css';

          function App() {
            const [taskOpen, setTaskOpen] = useState(false);
            const [editorOpen, setEditorOpen] = useState(false);
            const [actions, setActions] = useState(0);
            const [result, setResult] = useState('');
            const [modal, setModal] = useState(true);
            const [protectOutside, setProtectOutside] = useState(false);
            const [outsideInteractions, setOutsideInteractions] = useState(0);
            const requestText = useTextInputDialog();
            function notify() {
              toast.success('任务处理完成', {
                id: 'dialog-regression-message', duration: Infinity,
                description: '这条消息可以独立关闭或执行操作。',
                action: { label: '执行消息操作', onClick: () => setActions(value => value + 1) },
              });
            }
            async function input() {
              const value = await requestText({
                title: '填写系统备注', description: '输入后继续查看当前任务。',
                label: '系统备注', confirmLabel: '保存备注', defaultValue: '',
              });
              setResult(value ?? 'cancelled');
            }
            return <>
              <button onClick={() => setTaskOpen(true)}>打开任务信息</button>
              <button onClick={() => { setProtectOutside(true); setTaskOpen(true); }}>打开遮罩保护任务</button>
              <button onClick={() => { setModal(false); setTaskOpen(true); }}>打开非模态任务信息</button>
              <output data-testid="action-count">{actions}</output>
              <output data-testid="input-result">{result}</output>
              <output data-testid="outside-count">{outsideInteractions}</output>
              <Dialog open={taskOpen} onOpenChange={setTaskOpen} modal={modal}>
                <DialogContent className="workbench-review-dialog" data-testid="task-dialog" onInteractOutside={event => {
                  setOutsideInteractions(value => value + 1);
                  if (protectOutside) event.preventDefault();
                }}>
                  <header style={{ padding: '24px 70px 20px 24px' }}>
                    <DialogTitle>任务信息</DialogTitle>
                    <DialogDescription>使用工作台任务详情的共享弹窗和实际样式。</DialogDescription>
                  </header>
                  <div style={{ padding: 24 }}>
                    <button onClick={notify}>显示消息</button>
                    <button onClick={input}>打开系统输入</button>
                    <button onClick={() => setEditorOpen(true)}>打开图片编辑器</button>
                    <label>任务内输入<input aria-label="任务内输入" /></label>
                    <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
                      <DialogContent className={editorStyles.dialog} overlayClassName={editorStyles.overlay} data-testid="editor-dialog">
                        <header className={editorStyles.header}>
                          <DialogTitle>图片编辑器</DialogTitle>
                          <DialogDescription>使用图片编辑器的实际较高层级样式。</DialogDescription>
                        </header>
                        <div style={{ padding: 24 }}>
                          <button onClick={notify}>显示编辑消息</button>
                          <button onClick={input}>打开编辑系统输入</button>
                        </div>
                      </DialogContent>
                    </Dialog>
                  </div>
                </DialogContent>
              </Dialog>
            </>;
          }
          createRoot(document.getElementById('root')).render(
            <TextInputDialogProvider><App /><Toaster /></TextInputDialogProvider>
          );
        `,
        resolveDir: process.cwd(), loader: 'tsx',
      },
      bundle: true, outfile: join(directory, 'bundle.js'), jsx: 'automatic',
      platform: 'browser', conditions: ['style'], alias: { '@': process.cwd() },
      define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' },
    });
    const [js, rawCss] = await Promise.all([
      readFile(join(directory, 'bundle.js')),
      readFile(join(directory, 'bundle.css'), 'utf8'),
    ]);
    const { css } = await postcss([tailwind()]).process(rawCss, {
      from: join(process.cwd(), 'app/globals.css'),
    });
    server = createServer((request, response) => {
      if (request.url === '/bundle.js') {
        response.setHeader('content-type', 'application/javascript');
        response.end(js);
      } else if (request.url === '/bundle.css') {
        response.setHeader('content-type', 'text/css');
        response.end(css);
      } else if (request.url === '/') {
        response.setHeader('content-type', 'text/html');
        response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/bundle.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
      } else {
        unexpectedRequests.push(request.url);
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      headless: true, channel: process.env.DIALOG_NOTIFICATION_BROWSER_CHANNEL ?? 'msedge',
    });

    async function openTask(buttonName = '打开任务信息') {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(5_000);
      page.on('pageerror', error => browserErrors.push(error.message));
      await page.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        unexpectedRequests.push(route.request().url());
        return route.abort();
      });
      await page.goto(origin);
      await page.getByRole('button', { name: buttonName, exact: true }).click();
      await page.getByTestId('task-dialog').waitFor();
      return page;
    }

    async function showMessage(page, name = '显示消息') {
      await page.getByRole('button', { name, exact: true }).click();
      const message = page.locator('[data-sonner-toast]').filter({ hasText: '任务处理完成' });
      await message.waitFor();
      await message.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      return message;
    }

    async function clickVisibleCenter(page, locator) {
      const box = await locator.boundingBox();
      assert.ok(box, 'target must be visibly rendered');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }

    async function assertTaskOpen(page, reason) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.getByTestId('task-dialog').isVisible(), true, reason);
      assert.equal(await page.getByTestId('task-dialog').getAttribute('data-state'), 'open', reason);
    }

    await t.test('clicking the visible message card keeps task details open', async () => {
      const page = await openTask();
      try {
        const message = await showMessage(page), box = await message.boundingBox();
        assert.ok(box);
        // A physical click in the visible card's top padding detects click-through;
        // force-clicking the DOM element would conceal disabled pointer events.
        await page.mouse.click(box.x + box.width / 2, box.y + 4);
        await assertTaskOpen(page, 'clicking a notification must not close task details');
        assert.equal(await message.isVisible(), true, 'clicking the card does not dismiss its message');
      } finally { await page.close(); }
    });

    await t.test('closing a notification only dismisses that notification', async () => {
      const page = await openTask();
      try {
        const message = await showMessage(page);
        await clickVisibleCenter(page, message.locator('[data-close-button]'));
        await assertTaskOpen(page, 'closing a notification must not close task details');
        await message.waitFor({ state: 'hidden' });
      } finally { await page.close(); }
    });

    await t.test('a notification action executes once and leaves task details open', async () => {
      const page = await openTask();
      try {
        const message = await showMessage(page);
        await clickVisibleCenter(page, message.locator('[data-button]').filter({ hasText: '执行消息操作' }));
        assert.equal(await page.getByTestId('action-count').textContent(), '1', 'the message action must receive the click');
        await assertTaskOpen(page, 'a notification action must not close task details');
      } finally { await page.close(); }
    });

    await t.test('overlay clicks, Escape, and the close button still dismiss task details', async () => {
      for (const close of ['overlay', 'escape', 'button']) {
        const page = await openTask();
        try {
          if (close === 'overlay') await page.mouse.click(5, 500);
          else if (close === 'escape') await page.keyboard.press('Escape');
          else await page.getByTestId('task-dialog').getByRole('button', { name: '关闭弹窗', exact: true }).click();
          await page.getByTestId('task-dialog').waitFor({ state: 'hidden' });
          assert.equal(await page.getByRole('button', { name: '打开任务信息', exact: true }).isEnabled(), true);
        } finally { await page.close(); }
      }
    });

    await t.test('a caller can still prevent dismissal for a real outside interaction', async () => {
      const page = await openTask('打开遮罩保护任务');
      try {
        await page.mouse.click(5, 500);
        await assertTaskOpen(page, 'the supplied onInteractOutside callback still controls outside dismissal');
        assert.equal(await page.getByTestId('outside-count').textContent(), '1', 'the supplied callback receives the overlay interaction');
      } finally { await page.close(); }
    });

    await t.test('focusing a notification action preserves a non-modal dialog', async () => {
      const page = await openTask('打开非模态任务信息');
      try {
        const message = await showMessage(page);
        const action = message.locator('[data-button]').filter({ hasText: '执行消息操作' });
        await action.focus();
        await assertTaskOpen(page, 'focusing a notification must not dismiss a non-modal dialog');
        assert.equal(await action.evaluate(element => document.activeElement === element), true);
        await page.keyboard.press('Enter');
        assert.equal(await page.getByTestId('action-count').textContent(), '1', 'the focused action remains keyboard operable');
        await assertTaskOpen(page, 'a keyboard notification action preserves the non-modal dialog');
      } finally { await page.close(); }
    });

    await t.test('system text input appears above task details, accepts input, and returns to the task', async () => {
      const page = await openTask();
      try {
        await page.getByRole('button', { name: '打开系统输入', exact: true }).click();
        const system = page.getByRole('dialog', { name: '填写系统备注', exact: true });
        await system.waitFor();
        const field = page.getByLabel('系统备注', { exact: true });
        await field.click();
        await page.keyboard.type('保留底层任务');
        assert.equal(await field.inputValue(), '保留底层任务');
        await system.getByRole('button', { name: '保存备注', exact: true }).click();
        await system.waitFor({ state: 'hidden' });
        await assertTaskOpen(page, 'submitting system input keeps the underlying task open');
        assert.equal(await page.getByTestId('input-result').textContent(), '保留底层任务');
        await page.getByRole('button', { name: '打开系统输入', exact: true }).click();
        await system.getByRole('button', { name: '取消', exact: true }).click();
        await system.waitFor({ state: 'hidden' });
        await assertTaskOpen(page, 'cancelling system input keeps the underlying task open');
      } finally { await page.close(); }
    });

    await t.test('notification actions also work over the higher image editor layer', async () => {
      const page = await openTask();
      try {
        await page.getByRole('button', { name: '打开图片编辑器', exact: true }).click();
        const editor = page.getByTestId('editor-dialog');
        await editor.waitFor();
        const message = await showMessage(page, '显示编辑消息');
        await clickVisibleCenter(page, message.locator('[data-button]').filter({ hasText: '执行消息操作' }));
        assert.equal(await page.getByTestId('action-count').textContent(), '1', 'notification actions work over the image editor');
        assert.equal(await editor.isVisible(), true, 'notification actions keep the image editor open');
        await assertTaskOpen(page, 'notification actions also keep the underlying task open');
      } finally { await page.close(); }
    });

    await t.test('system input appears above the image editor and closing it preserves both lower dialogs', async () => {
      const page = await openTask();
      try {
        await page.getByRole('button', { name: '打开图片编辑器', exact: true }).click();
        const editor = page.getByTestId('editor-dialog');
        await editor.waitFor();
        await page.getByRole('button', { name: '打开编辑系统输入', exact: true }).click();
        const system = page.getByRole('dialog', { name: '填写系统备注', exact: true });
        await system.waitFor();
        const field = page.getByLabel('系统备注', { exact: true });
        const box = await field.boundingBox();
        assert.ok(box);
        assert.equal(await field.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), {
          x: box.x + box.width / 2, y: box.y + box.height / 2,
        }), true, 'system input must receive pointer events above the image editor');
        await field.click();
        await page.keyboard.type('编辑器上层备注');
        assert.equal(await field.inputValue(), '编辑器上层备注');
        await system.getByRole('button', { name: '取消', exact: true }).click();
        await system.waitFor({ state: 'hidden' });
        assert.equal(await editor.isVisible(), true, 'closing the system dialog preserves the image editor');
        await assertTaskOpen(page, 'closing the system dialog preserves the task below the editor');
        await page.keyboard.press('Escape');
        await editor.waitFor({ state: 'hidden' });
        await assertTaskOpen(page, 'Escape closes only the top image editor');
      } finally { await page.close(); }
    });

    assert.deepEqual(browserErrors, [], 'the fixture must not produce browser errors');
    assert.deepEqual(unexpectedRequests, [], 'the fixture makes no API or external requests');
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
