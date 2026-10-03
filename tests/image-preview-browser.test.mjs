import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('image preview keyboard navigation respects boundaries and focused controls', {
  skip: process.env.RUN_IMAGE_PREVIEW_BROWSER !== '1', timeout: 120_000,
}, async () => {
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  const output = resolve('.codex_artifacts/image-preview');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'browser-'));
  const bundle = join(directory, 'bundle.js');
  await build({
    stdin: {
      contents: `
        import './app/globals.css';
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { ImagePreview } from './app/components/image-preview';

        const images = [
          'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"%3E%3Crect width="20" height="20" fill="red"/%3E%3C/svg%3E',
          'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"%3E%3Crect width="20" height="20" fill="green"/%3E%3C/svg%3E',
          'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="2560" height="3000"%3E%3Crect width="2560" height="3000" fill="blue"/%3E%3C/svg%3E',
        ];

        function Harness() {
          const [index, setIndex] = useState(1);
          return <ImagePreview hideTrigger isOpen src={location.search.includes('flaky')?'/flaky.svg':images[index]} sourceSrc={images[0]} deliverySrc="/download.svg" format="SVG" transparency={{source:true,delivery:false}} alt={\`测试图片 \${index + 1}\`}
            position={index + 1} total={images.length}
            onPrevious={index > 0 ? () => setIndex(value => value - 1) : undefined}
            onNext={index < images.length - 1 ? () => setIndex(value => value + 1) : undefined} />;
        }

        createRoot(document.getElementById('root')).render(<Harness />);
      `,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    outfile: bundle,
    jsx: 'automatic',
    platform: 'browser',
    conditions: ['style'],
    alias: { '@': process.cwd() },
    define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' },
  });
  const js = await readFile(bundle);
  const rawCss = await readFile(join(directory, 'bundle.css'), 'utf8');
  const { default: postcss } = await import('postcss');
  const { default: tailwind } = await import('@tailwindcss/postcss');
  const { css } = await postcss([tailwind()]).process(rawCss, { from: resolve('app/globals.css') });
  const exportedSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>');
  let flaky = true, flakyReads = 0;
  const server = createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response.setHeader('content-type', 'application/javascript');
      response.end(js);
      return;
    }
    if (request.url === '/bundle.css') { response.setHeader('content-type', 'text/css'); response.end(css); return; }
    if (request.url === '/download.svg' || request.url === '/flaky.svg') {
      if (request.url === '/flaky.svg') flakyReads++;
      if (request.url === '/flaky.svg' && flaky) { response.writeHead(503); response.end('unavailable'); return; }
      response.setHeader('content-type', 'image/svg+xml');
      if (request.url === '/download.svg') response.setHeader('content-disposition', 'attachment; filename="preview.svg"');
      response.end(exportedSvg); return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script src="/bundle.js"></script></html>');
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.IMAGE_PREVIEW_BROWSER_CHANNEL || process.env.BROWSER_CHANNEL || 'msedge' });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const preview = page.getByRole('dialog');
    const position = preview.locator('.image-preview-position');
    await preview.waitFor();
    assert.equal(await position.textContent(), '2 / 3');

    await page.keyboard.press('ArrowLeft');
    await preview.getByText('1 / 3', { exact: true }).waitFor();
    assert.equal(await preview.getAttribute('aria-label'), '图片预览：测试图片 1');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await position.textContent(), '1 / 3', 'left arrow stops at the first image');

    await page.keyboard.press('ArrowRight');
    await preview.getByText('2 / 3', { exact: true }).waitFor();
    await page.keyboard.press('ArrowRight');
    await preview.getByText('3 / 3', { exact: true }).waitFor();
    await page.keyboard.press('ArrowRight');
    assert.equal(await position.textContent(), '3 / 3', 'right arrow stops at the last image');

    await preview.getByRole('button', { name: '100% 查看', exact: true }).click();
    const viewport = preview.locator('.image-preview-viewport');
    await page.waitForFunction(() => {
      const element = document.querySelector('.image-preview-viewport');
      return element.scrollWidth > element.clientWidth && element.scrollHeight > element.clientHeight;
    });
    await viewport.hover(); await page.mouse.wheel(500, 500);
    await page.waitForFunction(() => {
      const element = document.querySelector('.image-preview-viewport');
      return element.scrollLeft > 0 && element.scrollTop > 0;
    });
    await preview.getByRole('button', { name: '完整显示', exact: true }).click();
    assert.equal(await preview.getByRole('slider', { name: '调整预览倍数' }).isDisabled(), true);
    const imageBounds = await preview.locator('.image-preview-full').boundingBox();
    const viewportBounds = await viewport.boundingBox();
    assert.ok(imageBounds.width <= viewportBounds.width && imageBounds.height <= viewportBounds.height, 'fit mode displays the complete large source image');
    await preview.getByRole('button', { name: '100% 查看', exact: true }).click();
    const slider = preview.getByRole('slider', { name: '调整预览倍数' });
    const zoom = Number(await slider.inputValue());
    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(Number(await slider.inputValue()), zoom - 10, 'focused slider retains its arrow-key behavior');
    assert.equal(await position.textContent(), '3 / 3', 'focused slider does not navigate the image sequence');

    await preview.getByRole('button', { name: '向右旋转', exact: true }).focus();
    await page.keyboard.press('ArrowLeft');
    await preview.getByText('2 / 3', { exact: true }).waitFor();
    for (const name of ['白色预览底色', '棋盘格，便于检查透明区域', '深色预览底色']) {
      await preview.getByRole('button', { name, exact: true }).click();
      assert.equal(await preview.getByRole('button', { name, exact: true }).getAttribute('aria-pressed'), 'true');
    }
    const source = preview.getByRole('checkbox', { name: '查看处理前源图', exact: true });
    await source.check(); await preview.getByText('含透明像素', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.image-preview-full')?.getAttribute('src')?.includes('red'));
    await source.uncheck(); await preview.getByText('不透明图片 · SVG', { exact: true }).waitFor();
    await preview.getByRole('button', { name: '向右旋转', exact: true }).click();
    assert.equal(await preview.locator('.image-preview-full').evaluate(image => image.style.transform), 'rotate(90deg)');
    await preview.getByRole('button', { name: '向左旋转', exact: true }).click();
    await preview.getByRole('button', { name: '恢复预览', exact: true }).click();
    assert.equal(await preview.getByRole('slider', { name: '调整预览倍数' }).inputValue(), '100');
    assert.equal(await preview.locator('.image-preview-full').evaluate(image => image.style.transform), 'rotate(0deg)');
    const preference = preview.getByRole('switch', { name: '默认完整预览', exact: true });
    const savedMode = await preference.getAttribute('aria-checked');
    await preference.click(); assert.notEqual(await preference.getAttribute('aria-checked'), savedMode);
    await page.reload(); await preview.waitFor(); assert.notEqual(await preference.getAttribute('aria-checked'), savedMode);
    await preference.click(); assert.equal(await preference.getAttribute('aria-checked'), savedMode);
    const [download] = await Promise.all([page.waitForEvent('download'), preview.getByRole('link', { name: '下载交付文件', exact: true }).click()]);
    const downloadPath = join(directory, 'downloaded-preview.svg'); await download.saveAs(downloadPath);
    assert.deepEqual(await readFile(downloadPath), exportedSvg);
    await page.goto(`http://127.0.0.1:${server.address().port}/?flaky=1`);
    await page.getByRole('alert').filter({ hasText: '无法加载' }).waitFor(); flaky = false;
    await page.getByRole('button', { name: '重试加载', exact: true }).click();
    await page.waitForFunction(() => {
      const image = document.querySelector('.image-preview-full');
      return image?.src.endsWith('/flaky.svg') && image.complete && image.naturalWidth === 20
        && document.querySelector('.image-preview-viewport')?.getAttribute('aria-busy') === 'false';
    }).catch(async error => { console.log(JSON.stringify({ flakyReads, retryState: await page.evaluate(() => ({ src: document.querySelector('.image-preview-full')?.src, width: document.querySelector('.image-preview-full')?.naturalWidth, complete: document.querySelector('.image-preview-full')?.complete, busy: document.querySelector('.image-preview-viewport')?.getAttribute('aria-busy'), text: document.body.innerText })) })); throw error; });
    await page.getByRole('alert').filter({ hasText: '无法加载' }).waitFor({ state: 'hidden' });
    await page.screenshot({ path: join(directory, 'preview-controls-verified.png'), fullPage: true });
  } finally {
    await browser?.close();
    await new Promise(resolveClose => server.close(resolveClose));
  }
});
