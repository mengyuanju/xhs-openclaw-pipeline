// Local browser verification only: synthetic lifecycle records, no model requests.
// First build with XHS_NEXT_DIST_DIR=.codex_artifacts/remote-error-build, then run this file.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const root = await mkdtemp(join(tmpdir(), 'xhs-error-workbench-'));
const password = randomBytes(12).toString('hex');
const user = { id: 1, username: 'error-fixture', displayName: '离线错误验证', role: 'ADMIN',
  status: 'ACTIVE', credentialVersion: 1, mustChangePassword: false };
const end = new Date().toISOString(), start = new Date(Date.now() - 180_000).toISOString();
const base = { createdByUserId: user.username, createdByDisplayName: user.displayName, createdByRole: 'ADMIN',
  currentExecutionId: null, currentCopyRevisionId: 1, currentImageRunId: null,
  copyExecutorNodeId: 'copy-a', imageExecutorNodeId: 'image-b', imageExecutorNodeName: '生图执行机 B',
  createdAt: start, updatedAt: end, executionStartedAt: start, lastActivityAt: end, finishedAt: end,
  progressMessage: '离线回归展示：请检查错误详情与检查点后人工续跑' };
const tasks = [
  { ...base, id: 480, query: '离线样本：视觉规划超时', state: 'IMAGE_FAILED', currentStage: 'PLANNING', progressPercent: 33 },
  { ...base, id: 460, query: '离线样本：图片质检容量不足', state: 'IMAGE_FAILED', currentStage: 'QUALITY_CHECK', progressPercent: 87 },
  { ...base, id: 466, query: '离线样本：案例匹配超时', state: 'COPY_FAILED', currentStage: 'KNOWLEDGE_MATCH', progressPercent: 5,
    imageExecutorNodeId: null, imageExecutorNodeName: null },
  { ...base, id: 458, query: '离线样本：旧记录开始时间缺失', state: 'IMAGE_FAILED', currentStage: 'FAILED', progressPercent: 0,
    executionStartedAt: null },
  { ...base, id: 500, query: '离线样本：等待首次领取', state: 'COPY_QUEUED', currentStage: 'COPY_QUEUED', progressPercent: 0,
    executionStartedAt: null, finishedAt: null, copyExecutorNodeId: null, imageExecutorNodeId: null, imageExecutorNodeName: null },
];
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://127.0.0.1');
  let data;
  if (url.pathname === '/v1/auth/login' && req.method === 'POST') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    if (input.username !== user.username || input.password !== password) {
      res.writeHead(401); res.end(JSON.stringify({ error: { message: 'Invalid fixture login' } })); return;
    }
    data = user;
  } else if (req.method !== 'GET') {
    res.writeHead(405); res.end(JSON.stringify({ error: { message: 'Offline fixture is read-only' } })); return;
  } else if (url.pathname === '/v1/profile') data = user;
  else if (url.pathname === '/v1/nodes') data = [{ id: 'copy-a', name: '文案执行机 A', online: true, imageWorkerEnabled: false }];
  else if (url.pathname === '/v1/tasks') data = url.searchParams.get('includeTotal') === 'true'
    ? { items: tasks, total: tasks.length, limit: 20, offset: 0 } : tasks;
  else if (url.pathname === '/v1/users') data = [user];
  else if (url.pathname === '/v1/settings') data = [];
  else data = [];
  res.end(JSON.stringify({ data }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '3108'], {
  shell: false, windowsHide: true, stdio: 'inherit', env: { ...process.env,
    XHS_NEXT_DIST_DIR: '.codex_artifacts/remote-error-build', CONTROL_PLANE_URL: `http://127.0.0.1:${server.address().port}`,
    EXECUTOR_NODE_ID: 'error-fixture', XHS_SESSION_SECRET: randomBytes(32).toString('hex'),
    XHS_DB_PATH: join(root, 'queue.db'), XHS_OUTPUT_ROOT: join(root, 'output'), NODE_ENV: 'production',
  },
});
console.log(`Offline UI http://127.0.0.1:3108/login — user ${user.username}, temporary password ${password}`);
child.on('exit', () => server.close());
process.on('SIGINT', () => { child.kill(); server.close(); });
