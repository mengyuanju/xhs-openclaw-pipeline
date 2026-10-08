import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('workbench SSR browser: missing center configuration and unknown view use real page boundaries', {
  skip: process.env.RUN_WORKBENCH_ROUTE_BROWSER !== '1', timeout: 60_000,
}, async () => {
  const { build } = await import('esbuild'), { chromium } = await import('playwright-core');
  const root = resolve('.codex_artifacts/workbench-route'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'browser-'));
  await build({ entryPoints: [resolve('app/workbench/[view]/page.tsx')], bundle: true, outfile: join(directory, 'page.mjs'), format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', alias: { '@': process.cwd() }, plugins: [{ name: 'isolated-page-services', setup(plugin) {
    plugin.onResolve({ filter: /(?:server-session|next-runtime\.mjs|creation-workbench|next\/navigation)$/ }, args => ({ path: args.path, namespace: 'page-services' }));
    plugin.onLoad({ filter: /.*/, namespace: 'page-services' }, args => ({ loader: 'jsx', contents: args.path.endsWith('server-session') ? 'export const readServerSession=async()=>({roles:["ADMIN"],username:"synthetic",userId:7});'
      : args.path.endsWith('next-runtime.mjs') ? 'export const controlPlaneUrl=()=>null;export const executorNodeId=()=>{throw Error("Must not evaluate node ID without center")};'
      : args.path.endsWith('creation-workbench') ? 'export const CreationWorkbench=()=>{throw Error("Must not mount workbench without center")};'
      : 'export const notFound=()=>{const e=new Error("Unknown view");e.status=404;throw e};export const redirect=url=>{throw Error("Unexpected redirect "+url)};' }));
  } }] });
  const { default: Page } = await import(pathToFileURL(join(directory, 'page.mjs')));
  const { renderToStaticMarkup } = await import('react-dom/server'); let browser;
  const requests = [], errors = [];
  const server = createServer(async (request, response) => {
    const view = new URL(request.url, 'http://localhost').pathname.split('/').at(-1); requests.push(view);
    try { const element = await Page({ params: Promise.resolve({ view }), searchParams: Promise.resolve({}) }); response.setHeader('content-type', 'text/html; charset=utf-8'); response.end('<html><meta charset="utf-8">'+renderToStaticMarkup(element)+'</html>'); }
    catch (error) { if (error.status !== 404) errors.push(error.message); response.statusCode = error.status ?? 500; response.end(error.status === 404 ? '404 Unknown view' : error.message); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chromium-headless-shell' });
    const page = await browser.newPage(); const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await page.goto(origin+'/workbench/personal'); assert.equal(response.status(), 200);
    await page.getByText('请先配置中心服务连接，然后重启界面服务。', { exact: true }).waitFor();
    assert.equal(await page.locator('button,input').count(), 0);
    const unknown = await page.goto(origin+'/workbench/synthetic-unknown-view'); assert.equal(unknown.status(), 404);
    await page.getByText('404 Unknown view', { exact: true }).waitFor(); assert.deepEqual(errors, []);
    await writeFile(join(directory,'evidence.json'),JSON.stringify({ featureIds:['F-VIEW-010'], source:'actual WorkbenchListPage SSR with isolated session/config/navigation adapters', models:0, requests, errors },null,2));
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(done=>server.close(done)); }
});
