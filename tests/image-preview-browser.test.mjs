import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('image preview keyboard navigation respects boundaries and focused controls', {
  skip: process.env.RUN_IMAGE_PREVIEW_BROWSER !== '1', timeout: 60_000,
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
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { ImagePreview } from './app/components/image-preview';

        const images = [
          'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"%3E%3Crect width="20" height="20" fill="red"/%3E%3C/svg%3E',
          'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"%3E%3Crect width="20" height="20" fill="green"/%3E%3C/svg%3E',
          'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"%3E%3Crect width="20" height="20" fill="blue"/%3E%3C/svg%3E',
        ];

        function Harness() {
          const [index, setIndex] = useState(1);
          return <ImagePreview hideTrigger isOpen src={images[index]} alt={\`测试图片 \${index + 1}\`}
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
    alias: { '@': process.cwd() },
    define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' },
  });
  const js = await readFile(bundle);
  const server = createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response.setHeader('content-type', 'application/javascript');
      response.end(js);
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script></html>');
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.IMAGE_PREVIEW_BROWSER_CHANNEL || 'msedge' });
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
    const slider = preview.getByRole('slider', { name: '调整预览倍数' });
    const zoom = Number(await slider.inputValue());
    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(Number(await slider.inputValue()), zoom - 10, 'focused slider retains its arrow-key behavior');
    assert.equal(await position.textContent(), '3 / 3', 'focused slider does not navigate the image sequence');

    await preview.getByRole('button', { name: '向右旋转', exact: true }).focus();
    await page.keyboard.press('ArrowLeft');
    await preview.getByText('2 / 3', { exact: true }).waitFor();
  } finally {
    await browser?.close();
    await new Promise(resolveClose => server.close(resolveClose));
  }
});
