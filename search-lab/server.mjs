import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSearch } from './compare.mjs';
import { providerCatalogue } from './providers.mjs';
import { createCopyLabService } from './copy-service.mjs';

const publicDirectory = join(dirname(fileURLToPath(import.meta.url)), 'public');
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const MAX_BODY_BYTES = 32_768;

function send(response, status, type, body) {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

function sendJson(response, status, body) {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new RangeError('请求内容过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new TypeError('请求 JSON 格式不正确'); }
}

export function createSearchLabServer({ compare = compareSearch, catalogue = providerCatalogue,
  copyService = createCopyLabService() } = {}) {
  const server = createServer(async (request, response) => {
    try {
      // Binding to loopback alone does not prevent DNS rebinding through a Host
      // name that resolves to 127.0.0.1.
      const host = String(request.headers.host ?? '');
      if (!/^127\.0\.0\.1:[0-9]{1,5}$/u.test(host)) {
        sendJson(response, 403, { error: '仅允许从本机地址访问' });
        return;
      }
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (request.method === 'GET' && pathname === '/api/providers') {
        sendJson(response, 200, { providers: catalogue });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/copy-config') {
        sendJson(response, 200, await copyService.getConfiguration());
        return;
      }
      if (request.method === 'GET' && /^\/api\/copy-jobs\/[0-9a-f-]{36}$/u.test(pathname)) {
        const job = copyService.readJob(pathname.split('/').at(-1));
        sendJson(response, job ? 200 : 404, job ?? { error: '文案任务不存在或已过期' });
        return;
      }
      if (request.method === 'POST' && ['/api/compare', '/api/copy-jobs'].includes(pathname)) {
        const origin = request.headers.origin;
        if ((origin && origin !== `http://${host}`)
          || !String(request.headers['content-type'] ?? '').startsWith('application/json')) {
          sendJson(response, 403, { error: '只接受本站的 JSON 请求' });
          return;
        }
        const body = await readJson(request, pathname === '/api/copy-jobs' ? 256_000 : MAX_BODY_BYTES);
        if (pathname === '/api/copy-jobs') {
          let created;
          try { created = await copyService.createJob(body); }
          catch (error) {
            // This error is raised before a job exists or any model is called.
            // Renew only this known preflight failure, once, so an old open
            // page can recover after a restart without losing its API keys.
            if (error?.code !== 'COPY_CONFIGURATION_EXPIRED') throw error;
            const configuration = await copyService.getConfiguration();
            const retried = await copyService.createJob({ ...body, configurationId: configuration.configurationId });
            created = { ...retried, configurationRefreshed: true, copyConfiguration: configuration };
          }
          sendJson(response, 202, created);
        } else sendJson(response, 200, await compare(body));
        return;
      }
      const asset = request.method === 'GET' ? staticFiles.get(pathname) : null;
      if (asset) {
        const [filename, type] = asset;
        send(response, 200, type, await readFile(join(publicDirectory, filename)));
        return;
      }
      sendJson(response, 404, { error: '页面不存在' });
    } catch (error) {
      const badRequest = error instanceof TypeError || error instanceof RangeError;
      sendJson(response, badRequest ? 400 : 500, {
        error: badRequest ? error.message : '测试站处理请求失败',
        ...(error?.code === 'COPY_CONFIGURATION_EXPIRED' ? { code: error.code } : {}),
      });
    }
  });
  server.on('close', () => copyService.close?.());
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.SEARCH_LAB_PORT || 3077);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('SEARCH_LAB_PORT 不正确');
  createSearchLabServer().listen(port, '127.0.0.1', () => {
    console.log(`搜索服务测试站：http://127.0.0.1:${port}`);
  });
}
