// Local development E2E fixture only. It starts a stateful fake control plane
// and a real Next development server. It never opens PostgreSQL, invokes a
// model, or exposes publishing endpoints.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import JSZip from 'jszip';

const projectRoot = process.cwd();
const artifactParent = join(projectRoot, '.codex_artifacts');
await mkdir(artifactParent, { recursive: true });
const buildRoot = await mkdtemp(join(artifactParent, 'modular-e2e-'));
const dataRoot = await mkdtemp(join(tmpdir(), 'xhs-modular-e2e-'));
const nextManagedSnapshots = new Map(await Promise.all(
  ['next-env.d.ts', 'tsconfig.json'].map(async (name) => [name, await readFile(join(projectRoot, name), 'utf8')]),
));

async function restoreNextManagedFiles() {
  const buildRelative = relative(projectRoot, buildRoot).replaceAll('\\', '/');
  for (const [name, original] of nextManagedSnapshots) {
    const path = join(projectRoot, name);
    const current = await readFile(path, 'utf8');
    let normalized = current;
    if (name === 'next-env.d.ts') {
      normalized = normalized
        .replaceAll(`./${buildRelative}/dev/types/routes.d.ts`, './.next/types/routes.d.ts')
        .replaceAll(`./${buildRelative}/dev/types/root-params.d.ts`, './.next/types/root-params.d.ts');
    } else {
      normalized = normalized
        .replace(`,\n    "${buildRelative}/types/**/*.ts",\n    "${buildRelative}/dev/types/**/*.ts"`, '');
    }
    if (normalized === original && current !== original) await writeFile(path, original, 'utf8');
    else if (current !== original) console.warn(`MODULAR_E2E_CLEANUP_SKIPPED ${name}: concurrent edits detected`);
  }
}

const passwords = {
  admin: `fixture-${randomBytes(8).toString('hex')}`,
  reviewer: `fixture-${randomBytes(8).toString('hex')}`,
  worker: `fixture-${randomBytes(8).toString('hex')}`,
};
const users = {
  admin: { id: 1, username: 'admin', displayName: 'E2E 管理员', role: 'ADMIN', status: 'ACTIVE', credentialVersion: 1, mustChangePassword: false },
  reviewer: { id: 91, username: 'reviewer', displayName: 'E2E 质检员', role: 'REVIEWER', status: 'ACTIVE', credentialVersion: 1, mustChangePassword: false },
  worker: { id: 22, username: 'worker', displayName: 'E2E 作业人员', role: 'USER', status: 'ACTIVE', credentialVersion: 1, mustChangePassword: false },
};

const state = {
  nextPackageId: 9,
  nextItemId: 101,
  nextBatchId: 301,
  nextTaskId: 501,
  packages: [],
  batches: [],
  requests: [],
  deliveryExports: [],
  deliveryArchives: new Map(),
  deliveryEntries: [{
    id: 1,
    taskId: 701,
    query: '玄关收纳交付词',
    copyRevisionId: 801,
    imageRunId: '11111111-1111-4111-8111-111111111111',
    status: 'READY',
    approvedAt: '2026-09-09T08:30:00.000Z',
  }, {
    id: 2,
    taskId: 702,
    query: '厨房动线交付词',
    copyRevisionId: 802,
    imageRunId: '22222222-2222-4222-8222-222222222222',
    status: 'READY',
    approvedAt: '2026-09-09T08:31:00.000Z',
  }, {
    id: 3,
    taskId: 703,
    query: '衣柜分区交付词',
    copyRevisionId: 803,
    imageRunId: '33333333-3333-4333-8333-333333333333',
    status: 'READY',
    approvedAt: '2026-09-09T08:32:00.000Z',
  }],
  qaItems: [{
    id: '71717171-7171-4717-8717-717171717171',
    freezePublicId: '81818181-8181-4818-8818-818181818181',
    anonymousCode: 'QC-5B1E06B6F45A',
    status: 'PENDING',
    sampleKind: 'RANDOM',
    query: 'SECRET-QUERY-MUST-NOT-REACH-BLIND-UI',
    approvedRevision: {
      content: { copy: { title: '玄关整理的三个动作', body: '先清空，再分区，最后只保留每天会用的物品。', tags: ['收纳', '玄关'] } },
      contentSha256: 'a'.repeat(64),
      revisionToken: 'a'.repeat(64),
    },
    productionBatch: { anonymousCode: 'QCB-977A0A73B9DA' },
    createdAt: '2026-09-09T08:00:00.000Z',
  }, {
    id: '72727272-7272-4727-8727-727272727272',
    freezePublicId: '81818181-8181-4818-8818-818181818181',
    anonymousCode: 'QC-HELD-NOT-SELECTED',
    status: 'NOT_SELECTED',
    sampleKind: 'RANDOM',
    query: 'SECOND-HELD-QUERY',
    approvedRevision: {
      content: { copy: { title: '同批未抽中稿', body: '保持冻结，等待明确处置。', tags: ['未抽中'] } },
      contentSha256: 'b'.repeat(64),
      revisionToken: 'b'.repeat(64),
    },
    productionBatch: { anonymousCode: 'QCB-977A0A73B9DA' },
    createdAt: '2026-09-09T08:00:01.000Z',
  }, {
    id: '73737373-7373-4737-8737-737373737373',
    freezePublicId: '81818181-8181-4818-8818-818181818181',
    anonymousCode: 'QC-HELD-PASSED',
    status: 'PASSED',
    sampleKind: 'RANDOM',
    query: 'THIRD-HELD-QUERY',
    approvedRevision: {
      content: { copy: { title: '同批已抽检通过稿', body: '仍属于同一冻结范围。', tags: ['已通过'] } },
      contentSha256: 'c'.repeat(64),
      revisionToken: 'c'.repeat(64),
    },
    productionBatch: { anonymousCode: 'QCB-977A0A73B9DA' },
    createdAt: '2026-09-09T08:00:02.000Z',
  }],
};

if (process.env.MODULAR_E2E_PAGINATION_SEED === '1') {
  const seedCreatedAt = Date.parse('2026-09-09T07:00:00.000Z');
  for (let index = 1; index <= 205; index += 1) {
    const packageId = 1_000 + index;
    const itemId = 10_000 + index;
    const createdAt = new Date(seedCreatedAt + index * 1_000).toISOString();
    state.packages.push({
      id: packageId,
      name: `分页词包-${String(index).padStart(4, '0')}`,
      status: 'SCREENING',
      assignedToUserId: users.worker.username,
      assignedToAccountId: users.worker.id,
      assignedToDisplayName: users.worker.displayName,
      version: 1,
      createdAt,
      updatedAt: createdAt,
      items: [{
        id: itemId,
        rowNumber: 1,
        externalId: null,
        query: `分页 Query ${index}`,
        input: {},
        requestedImageCount: 'auto',
        screeningDecision: 'PENDING',
        screeningReason: null,
        taskId: null,
        version: 1,
      }],
    });
  }
  state.nextPackageId = 1_206;
  state.nextItemId = 10_206;

  for (let index = 1; index <= 204; index += 1) {
    const digest = index.toString(16).padStart(64, '0');
    state.qaItems.push({
      id: `90000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      freezePublicId: '81818181-8181-4818-8818-818181818181',
      anonymousCode: `QC-PAGE-${String(index).padStart(4, '0')}`,
      status: 'PENDING',
      sampleKind: 'RANDOM',
      query: `BLIND-PAGINATION-QUERY-${index}`,
      approvedRevision: {
        content: { copy: { title: `分页抽检稿 ${index}`, body: `用于验证第 ${index} 条分页抽检数据。`, tags: ['分页'] } },
        contentSha256: digest,
        revisionToken: digest,
      },
      productionBatch: { anonymousCode: 'QCB-977A0A73B9DA' },
      createdAt: new Date(seedCreatedAt + index * 1_000).toISOString(),
    });
  }
}

function paginate(url, entries, maximumLimit = 200) {
  const limit = Math.min(maximumLimit, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  return { items: entries.slice(offset, offset + limit), total: entries.length };
}

function counts(record) {
  return {
    total: record.items.length,
    pending: record.items.filter((item) => item.screeningDecision === 'PENDING').length,
    selected: record.items.filter((item) => item.screeningDecision === 'SELECTED').length,
    rejected: record.items.filter((item) => item.screeningDecision === 'REJECTED').length,
    produced: record.items.filter((item) => item.taskId).length,
  };
}

function packageSummary(record) {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    assignedToUserId: record.assignedToUserId,
    assignedToAccountId: record.assignedToAccountId,
    assignedToDisplayName: record.assignedToDisplayName,
    version: record.version,
    counts: counts(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function packageDetail(record) {
  return {
    ...packageSummary(record),
    items: record.items.map((item) => ({ ...item })),
  };
}

function actorRole(req) {
  return String(req.headers['x-actor-role'] ?? '').toUpperCase();
}

function actorUser(req) {
  return Object.values(users).find((candidate) => candidate.username === req.headers['x-actor-username']) ?? null;
}

function canAccessPackage(req, record) {
  const actor = actorUser(req);
  return actor?.role === 'ADMIN' || (actor?.role === 'USER'
    && record.assignedToUserId === actor.username && record.assignedToAccountId === actor.id);
}

function qaItemFor(req, item) {
  if (actorRole(req) === 'ADMIN') {
    return {
      ...item,
      blindReview: false,
      query: item.query,
      taskId: 991,
      approvedRevision: { ...item.approvedRevision, id: 902 },
      productionBatch: {
        ...item.productionBatch,
        id: 27,
        publicId: '91919191-9191-4919-8919-919191919191',
      },
      source: {
        finalApproverAccountId: 64,
        finalApproverUsername: 'worker',
        assignedToUserId: 'worker',
        createdByUserId: 'admin',
      },
      capabilities: { canPass: item.status === 'PENDING', canReturnSingle: item.status === 'PENDING', canReturnBatch: ['PENDING', 'RETURNED'].includes(item.status) },
    };
  }
  return {
    id: item.id,
    freezePublicId: item.freezePublicId,
    anonymousCode: item.anonymousCode,
    blindReview: true,
    status: item.status,
    sampleKind: item.sampleKind,
    approvedRevision: structuredClone(item.approvedRevision),
    productionBatch: structuredClone(item.productionBatch),
    capabilities: { canPass: item.status === 'PENDING', canReturnSingle: item.status === 'PENDING', canReturnBatch: false },
    createdAt: item.createdAt,
  };
}

async function jsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(status >= 400 ? { error: data } : { data }));
}

function error(res, status, code, message) {
  send(res, status, { code, message });
}

const controlPlane = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const method = String(req.method).toUpperCase();
    state.requests.push({ method, path: url.pathname, role: actorRole(req), at: new Date().toISOString() });

    if (method === 'GET' && url.pathname === '/health') {
      send(res, 200, {
        ok: true,
        fixture: true,
        capabilities: { taskAssignmentVersion: 3, finalDeliveryVersion: 2 },
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/auth/login') {
      const input = await jsonBody(req);
      const user = users[String(input.username ?? '').toLowerCase()];
      if (!user || passwords[user.username] !== input.password) {
        error(res, 401, 'INVALID_CREDENTIALS', 'fixture login failed');
        return;
      }
      send(res, 200, user);
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/profile') {
      const user = Object.values(users).find((candidate) => candidate.username === req.headers['x-actor-username']);
      if (!user) error(res, 401, 'AUTH_REQUIRED', 'fixture actor missing');
      else send(res, 200, user);
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/workflow-quality-settings') {
      send(res, 200, {
        version: 7,
        queryPackage: { workerImportEnabled: false },
        copySampling: { enabled: true, rateBps: 2500, blindReviewEnabled: true, reviewerBatchReturnEnabled: false },
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/users') {
      send(res, 200, Object.values(users));
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/delivery-pool') {
      if (!['ADMIN', 'USER'].includes(actorRole(req))) {
        error(res, 403, 'FORBIDDEN', 'fixture delivery-pool access denied');
        return;
      }
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const items = state.deliveryEntries.slice(offset, offset + limit);
      send(res, 200, url.searchParams.get('includeTotal') === 'true'
        ? { items, total: state.deliveryEntries.length }
        : items);
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/delivery-pool/archive') {
      if (actorRole(req) !== 'ADMIN') {
        error(res, 403, 'FORBIDDEN', 'fixture delivery-pool export is admin-only');
        return;
      }
      const input = await jsonBody(req);
      const taskIds = input.scope === 'ALL_READY'
        ? state.deliveryEntries.map((entry) => entry.taskId)
        : Array.isArray(input.taskIds) ? input.taskIds.map(Number) : [];
      if (!taskIds.length) {
        error(res, 409, 'DELIVERY_POOL_EMPTY', 'fixture delivery pool is empty');
        return;
      }
      state.deliveryExports.push({
        scope: input.scope,
        taskIds,
        requestTaskIds: input.taskIds ?? null,
      });
      const zip = new JSZip();
      for (const taskId of taskIds) {
        zip.file(`任务-${taskId}-资源包.zip`, Buffer.from(`fixture-${taskId}`));
      }
      const content = await zip.generateAsync({ type: 'nodebuffer' });
      const downloadId = randomUUID();
      const fileName = input.scope === 'ALL_READY'
        ? '交付池-全部可交付项.zip'
        : '交付池-已选资源.zip';
      state.deliveryArchives.set(downloadId, { content, fileName, taskCount: taskIds.length });
      send(res, 201, {
        downloadId,
        fileName,
        taskCount: taskIds.length,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
      return;
    }
    const deliveryDownloadMatch = url.pathname.match(/^\/v1\/delivery-pool\/archive\/([0-9a-f-]+)$/u);
    if (method === 'HEAD' && deliveryDownloadMatch) {
      if (actorRole(req) !== 'ADMIN') {
        error(res, 403, 'FORBIDDEN', 'fixture delivery-pool export is admin-only');
        return;
      }
      const archive = state.deliveryArchives.get(deliveryDownloadMatch[1]);
      if (!archive) {
        error(res, 404, 'NOT_FOUND', 'fixture delivery export is missing');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="delivery-pool.zip"',
        'Content-Length': String(archive.content.byteLength),
        'X-Delivery-Task-Count': String(archive.taskCount),
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }
    if (method === 'GET' && deliveryDownloadMatch) {
      if (actorRole(req) !== 'ADMIN') {
        error(res, 403, 'FORBIDDEN', 'fixture delivery-pool export is admin-only');
        return;
      }
      const archive = state.deliveryArchives.get(deliveryDownloadMatch[1]);
      if (!archive) {
        error(res, 404, 'NOT_FOUND', 'fixture delivery export is missing');
        return;
      }
      state.deliveryArchives.delete(deliveryDownloadMatch[1]);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="delivery-pool.zip"',
        'Content-Length': String(archive.content.byteLength),
        'Cache-Control': 'no-store',
      });
      res.end(archive.content);
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/query-packages') {
      const actor = actorUser(req);
      if (!actor || actor.role === 'REVIEWER') {
        error(res, 403, 'FORBIDDEN', 'fixture query package access denied');
        return;
      }
      const visiblePackages = actor.role === 'ADMIN'
        ? state.packages
        : state.packages.filter((record) => record.assignedToUserId === actor.username
          && record.assignedToAccountId === actor.id);
      const page = paginate(url, visiblePackages);
      send(res, 200, page.items.map(packageSummary));
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/query-packages') {
      if (actorRole(req) !== 'ADMIN') {
        error(res, 403, 'WORKER_QUERY_IMPORT_DISABLED', 'fixture worker query import is disabled');
        return;
      }
      const input = await jsonBody(req);
      const now = new Date().toISOString();
      const requestedAssignee = input.assignedToUserId === undefined
        ? null
        : Object.values(users).find((candidate) => candidate.role === 'USER'
          && candidate.status === 'ACTIVE' && candidate.username === String(input.assignedToUserId).toLowerCase());
      if (input.assignedToUserId !== undefined && !requestedAssignee) {
        error(res, 409, 'ASSIGNEE_UNAVAILABLE', 'fixture assignee is unavailable');
        return;
      }
      const record = {
        id: state.nextPackageId++,
        name: String(input.name),
        status: 'SCREENING',
        assignedToUserId: requestedAssignee?.username ?? null,
        assignedToAccountId: requestedAssignee?.id ?? null,
        assignedToDisplayName: requestedAssignee?.displayName ?? null,
        version: 1,
        createdAt: now,
        updatedAt: now,
        items: input.items.map((item, index) => ({
          id: state.nextItemId++,
          rowNumber: index + 1,
          externalId: null,
          query: String(item.query),
          input: item.input ?? {},
          requestedImageCount: item.requestedImageCount ?? 'auto',
          screeningDecision: 'PENDING',
          screeningReason: null,
          taskId: null,
          version: 1,
        })),
      };
      state.packages.push(record);
      send(res, 201, packageSummary(record));
      return;
    }
    const assigneeMatch = url.pathname.match(/^\/v1\/query-packages\/(\d+)\/assignee$/u);
    if (method === 'PATCH' && assigneeMatch) {
      if (actorRole(req) !== 'ADMIN') {
        error(res, 403, 'FORBIDDEN', 'fixture package assignment is admin-only');
        return;
      }
      const record = state.packages.find((entry) => entry.id === Number(assigneeMatch[1]));
      const input = await jsonBody(req);
      if (!record) {
        error(res, 404, 'QUERY_PACKAGE_NOT_FOUND', 'fixture package missing');
        return;
      }
      if (Number(input.expectedVersion) !== record.version) {
        error(res, 409, 'VERSION_CONFLICT', 'fixture package version is stale');
        return;
      }
      const assignee = Object.values(users).find((candidate) => candidate.role === 'USER'
        && candidate.status === 'ACTIVE' && candidate.username === String(input.assignedToUserId).toLowerCase());
      if (!assignee) {
        error(res, 409, 'ASSIGNEE_UNAVAILABLE', 'fixture assignee is unavailable');
        return;
      }
      record.assignedToUserId = assignee.username;
      record.assignedToAccountId = assignee.id;
      record.assignedToDisplayName = assignee.displayName;
      record.version += 1;
      record.updatedAt = new Date().toISOString();
      send(res, 200, packageSummary(record));
      return;
    }
    const packageMatch = url.pathname.match(/^\/v1\/query-packages\/(\d+)$/u);
    if (method === 'GET' && packageMatch) {
      const record = state.packages.find((entry) => entry.id === Number(packageMatch[1]));
      if (!record) error(res, 404, 'QUERY_PACKAGE_NOT_FOUND', 'fixture package missing');
      else if (!canAccessPackage(req, record)) error(res, 404, 'QUERY_PACKAGE_NOT_FOUND', 'fixture package missing');
      else send(res, 200, packageDetail(record));
      return;
    }
    const screenMatch = url.pathname.match(/^\/v1\/query-packages\/(\d+)\/screening$/u);
    if (method === 'PUT' && screenMatch) {
      const record = state.packages.find((entry) => entry.id === Number(screenMatch[1]));
      const input = await jsonBody(req);
      if (!record) {
        error(res, 404, 'QUERY_PACKAGE_NOT_FOUND', 'fixture package missing');
        return;
      }
      if (!canAccessPackage(req, record)) {
        error(res, 404, 'QUERY_PACKAGE_NOT_FOUND', 'fixture package missing');
        return;
      }
      for (const decision of input.decisions ?? []) {
        const item = record.items.find((candidate) => candidate.id === Number(decision.itemId));
        if (!item || item.taskId) continue;
        item.screeningDecision = decision.decision === 'SELECT' ? 'SELECTED' : 'REJECTED';
        item.screeningReason = decision.reason ?? null;
        item.version += 1;
      }
      record.version += 1;
      record.updatedAt = new Date().toISOString();
      const remaining = counts(record);
      record.status = remaining.pending ? 'SCREENING' : remaining.selected ? 'READY' : 'ABANDONED';
      send(res, 200, packageDetail(record));
      return;
    }
    const productionMatch = url.pathname.match(/^\/v1\/query-packages\/(\d+)\/production-batches$/u);
    if (method === 'POST' && productionMatch) {
      const record = state.packages.find((entry) => entry.id === Number(productionMatch[1]));
      const input = await jsonBody(req);
      if (!record) {
        error(res, 404, 'QUERY_PACKAGE_NOT_FOUND', 'fixture package missing');
        return;
      }
      if (!canAccessPackage(req, record)) {
        error(res, 404, 'QUERY_PACKAGE_NOT_FOUND', 'fixture package missing');
        return;
      }
      const requested = new Set((input.itemIds ?? []).map(Number));
      const items = record.items.filter((item) => requested.has(item.id)
        && item.screeningDecision === 'SELECTED' && !item.taskId);
      if (!items.length || items.length !== requested.size) {
        error(res, 409, 'ITEM_SCOPE_CHANGED', 'fixture production scope is stale');
        return;
      }
      const taskIds = items.map((item) => {
        item.taskId = state.nextTaskId++;
        item.version += 1;
        return item.taskId;
      });
      const batch = { id: state.nextBatchId++, publicId: randomUUID(), queryPackageId: record.id, status: 'OPEN', taskIds };
      state.batches.push(batch);
      record.version += 1;
      record.updatedAt = new Date().toISOString();
      record.status = record.items.some((item) => item.screeningDecision === 'SELECTED' && !item.taskId)
        ? 'PARTIALLY_USED' : 'USED_UP';
      send(res, 201, batch);
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/copy-qa/items') {
      const visibleItems = state.qaItems
        .filter((item) => item.status !== 'NOT_SELECTED')
        .filter((item) => !url.searchParams.get('status') || url.searchParams.get('status') === 'ALL' || item.status === url.searchParams.get('status'));
      const page = paginate(url, visibleItems);
      send(res, 200, page.items.map((item) => qaItemFor(req, item)));
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/copy-qa/statistics') {
      if (actorRole(req) !== 'ADMIN') error(res, 403, 'FORBIDDEN', 'fixture statistics are admin-only');
      else send(res, 200, { random: [], mandatory: { passed: 0, returned: 0, pending: 0 }, batchAffectedCount: 0 });
      return;
    }
    const qaDetailMatch = url.pathname.match(/^\/v1\/copy-qa\/items\/([0-9a-f-]+)$/u);
    if (method === 'GET' && qaDetailMatch) {
      const item = state.qaItems.find((entry) => entry.id === qaDetailMatch[1]);
      if (!item) error(res, 404, 'QA_ITEM_NOT_FOUND', 'fixture QA item missing');
      else if (actorRole(req) === 'REVIEWER' && item.status === 'NOT_SELECTED') {
        error(res, 404, 'QA_ITEM_NOT_FOUND', 'fixture QA item missing');
      }
      else send(res, 200, qaItemFor(req, item));
      return;
    }
    const qaActionMatch = url.pathname.match(/^\/v1\/copy-qa\/items\/([0-9a-f-]+)\/(pass|return)$/u);
    if (method === 'POST' && qaActionMatch) {
      const item = state.qaItems.find((entry) => entry.id === qaActionMatch[1]);
      const input = await jsonBody(req);
      if (!item) {
        error(res, 404, 'QA_ITEM_NOT_FOUND', 'fixture QA item missing');
        return;
      }
      if (input.expectedRevisionToken !== item.approvedRevision.revisionToken) {
        error(res, 409, 'STALE_QA_ITEM', 'fixture revision token is stale');
        return;
      }
      item.status = qaActionMatch[2] === 'pass' ? 'PASSED' : 'RETURNED';
      send(res, 200, { id: item.id, status: item.status, ...(item.status === 'PASSED' ? { releasedCount: 0 } : {}) });
      return;
    }
    const previewMatch = url.pathname.match(/^\/v1\/copy-qa\/freezes\/([0-9a-f-]+)\/batch-return-preview$/u);
    if (method === 'GET' && previewMatch) {
      const items = state.qaItems.filter((item) => item.freezePublicId === previewMatch[1]
        && ['PENDING', 'RETURNED', 'PASSED', 'NOT_SELECTED'].includes(item.status));
      send(res, 200, {
        freezePublicId: previewMatch[1],
        confirmedCount: items.length,
        triggerCandidates: items.filter((item) => ['PENDING', 'RETURNED'].includes(item.status)).map((item) => item.id),
        items: items.map((item) => ({ id: item.id, status: item.status })),
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/copy-qa/batch-return') {
      const input = await jsonBody(req);
      for (const item of state.qaItems.filter((candidate) => input.itemIds?.includes(candidate.id))) {
        if (item.id !== input.triggerSamplingItemId) item.status = 'BATCH_AFFECTED';
        else if (item.status !== 'RETURNED') item.status = 'RETURNED';
      }
      send(res, 200, { freezePublicId: input.freezePublicId, status: 'BATCH_RETURNED' });
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/tasks') {
      send(res, 200, []);
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/tasks/991' && actorRole(req) === 'REVIEWER') {
      error(res, 404, 'TASK_NOT_FOUND', 'task not found');
      return;
    }
    if (method === 'GET' && url.pathname === '/__fixture/state') {
      send(res, 200, {
        packages: state.packages.map(packageDetail),
        batches: structuredClone(state.batches),
        qaItems: state.qaItems.map((item) => ({ id: item.id, status: item.status })),
        deliveryExports: structuredClone(state.deliveryExports),
        requests: state.requests,
      });
      return;
    }

    error(res, 404, 'FIXTURE_ROUTE_NOT_FOUND', `${method} ${url.pathname} is not available in the isolated E2E fixture`);
  } catch (caught) {
    error(res, 500, 'FIXTURE_ERROR', caught instanceof Error ? caught.message : 'fixture failed');
  }
});

await new Promise((resolve, reject) => {
  controlPlane.listen(0, '127.0.0.1', resolve);
  controlPlane.once('error', reject);
});

async function reservePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.listen(0, '127.0.0.1', resolve);
    reservation.once('error', reject);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

const nextPort = await reservePort();
const nextRoot = `http://127.0.0.1:${nextPort}`;
const nextEnvironment = {
  ...process.env,
  CONTROL_PLANE_URL: `http://127.0.0.1:${controlPlane.address().port}`,
  EXECUTOR_NODE_ID: 'modular-e2e-fixture',
  XHS_SESSION_SECRET: randomBytes(32).toString('hex'),
  XHS_NEXT_DIST_DIR: relative(projectRoot, buildRoot),
  XHS_DB_PATH: join(dataRoot, 'unused.sqlite'),
  XHS_OUTPUT_ROOT: join(dataRoot, 'unused-output'),
  NEXT_TELEMETRY_DISABLED: '1',
  NO_COLOR: '1',
};
delete nextEnvironment.NODE_ENV;

const next = spawn(process.execPath, [
  'node_modules/next/dist/bin/next', 'dev', '-H', '127.0.0.1', '-p', String(nextPort),
], {
  cwd: projectRoot,
  env: nextEnvironment,
  shell: false,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
next.stdout.pipe(process.stdout);
next.stderr.pipe(process.stderr);

let ready = false;
for (let attempt = 0; attempt < 240; attempt += 1) {
  if (next.exitCode !== null) throw new Error(`Next development server exited early (${next.exitCode})`);
  const response = await fetch(`${nextRoot}/login`).catch(() => null);
  if (response?.ok) {
    ready = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!ready) throw new Error('Next development server did not become ready within 60 seconds');

console.log(`MODULAR_E2E_READY ${JSON.stringify({
  url: nextRoot,
  admin: { username: 'admin', password: passwords.admin },
  reviewer: { username: 'reviewer', password: passwords.reviewer },
  worker: { username: 'worker', password: passwords.worker },
  isolation: { fakeControlPlane: true, database: false, model: false, publishing: false },
})}`);

let stop;
const stopped = new Promise((resolve) => { stop = resolve; });
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
next.once('exit', stop);
await stopped;

if (next.exitCode === null) {
  next.kill('SIGTERM');
  await new Promise((resolve) => next.once('exit', resolve));
}
await new Promise((resolve) => controlPlane.close(resolve));
await restoreNextManagedFiles();
await rm(buildRoot, { recursive: true, force: true });
await rm(dataRoot, { recursive: true, force: true });
