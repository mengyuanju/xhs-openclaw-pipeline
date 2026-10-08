import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { describe, it } from 'node:test';
import { createCopyLabService } from '../search-lab/copy-service.mjs';
import { createSearchLabServer } from '../search-lab/server.mjs';
import { generateLabCopy } from '../search-lab/generate.mjs';
import { createMockPost } from '../src/pipeline.mjs';
import { PROMPT_KINDS } from '../src/prompt-catalog.mjs';
import { createPromptRuntime, defaultBusinessPrompt } from '../src/prompt-runtime.mjs';

const QUERY = '湖北黄石市无籽黑皮西瓜怎么样';
const API_KEY = 'fake-user-api-key';
const ENV_SECRET = 'fake-server-secret';

function configuration(version = 1) {
  const systemPrompt = `发布文案提示词第 ${version} 版：依据来源生成标题、正文和标签。`;
  const promptRuntime = createPromptRuntime({ source: 'TEST_CONFIGURATION',
    settings: { queryReviewEnabled: false }, prompts: {
      ...Object.fromEntries(PROMPT_KINDS.map(kind => [kind, { content: defaultBusinessPrompt(kind) }])),
      TEXT_SYSTEM: { content: systemPrompt, versionId: version, version },
    } });
  return { systemPrompt, promptRuntime, source: 'TEST_CONFIGURATION', settings: promptRuntime.settings,
    productionSettings: { modelApi: { textModel: 'openai/fake-model' }, privateCredential: ENV_SECRET },
    knowledge: [{ kind: 'VISUAL', content: { privateReference: ENV_SECRET } }] };
}

function research(query = QUERY) {
  return { schemaVersion: 1, status: 'COMPLETED', query,
    searchedAt: '2026-09-29T00:00:00.000Z', provider: 'tencent-wsa', summary: '可核验的搜索资料。',
    attempts: [{ provider: 'tencent-wsa', status: 'COMPLETED', error: null }],
    sources: [{ title: '来源', url: 'https://www.example.com/watermelon', snippet: '公开来源摘录。',
      siteName: 'example.com', provider: 'tencent-wsa', retrievedAt: '2026-09-29T00:00:00.000Z' }] };
}

function request(extra = {}) {
  return { query: QUERY, research: research(), generation: { provider: 'system' }, ...extra };
}

function fakeResult(extra = {}) {
  return { schemaVersion: 1, status: 'COMPLETED', post: { title: '生成标题' },
    copy: { title: '生成标题', body: '生成正文', tags: ['#西瓜'] }, promptTrace: [], ...extra };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  assert.fail('测试任务未在限定时间内完成');
}

async function completedJob(service, jobId) {
  return waitFor(() => { const job = service.readJob(jobId); return job && job.status !== 'RUNNING' ? job : null; });
}

function createService(overrides = {}) {
  return createCopyLabService({ environment: { XHS_TEST_SECRET: ENV_SECRET },
    loadConfiguration: async () => configuration(), checkLogin: async () => {},
    createClient: async ({ signal }) => ({ client: { signal }, model: 'fake-model',
      reviewModel: 'fake-review-model', provider: 'FAKE', thinking: 'low', secrets: [] }),
    generate: async () => fakeResult(), ...overrides });
}

async function requestWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { Host: host } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('search lab copy jobs', () => {
  it('runs the real writing orchestration with fake models and emits stages', async (t) => {
    const generatedPost = { ...createMockPost(3), title: '无籽黑皮西瓜的选购要点',
      body: `${'公开资料中的产品信息。'.repeat(44)}。` };
    const service = createService({ generate: generateLabCopy,
      createClient: async () => ({ client: {
        async runText() { return { rawText: JSON.stringify(generatedPost), model: 'fake-model' }; },
        async runReview() { return { rawText: JSON.stringify({ schemaVersion: 1, decision: 'PASS',
          summary: '审核通过', issues: [] }), model: 'fake-review-model' }; },
        async runWebSearch() { assert.fail('已有资料不得重复搜索'); },
      }, secrets: [] }) });
    t.after(() => service.close());
    const { jobId } = await service.createJob(request());
    assert.match(jobId, /^[0-9a-f-]{36}$/u);
    const job = await completedJob(service, jobId);
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.result.copy.title, generatedPost.title);
    assert.equal(job.result.imagePlan.length, 3);
    assert.ok(job.events.some(({ stage }) => stage === 'RESEARCH'));
    assert.ok(job.events.some(({ stage }) => stage === 'ORIGINAL_REVIEW'));
    assert.ok(job.prompts.some(({ method }) => method === 'runText'));
    assert.equal(job.result.generationSettings.model, null);
    assert.equal(job.result.generation.research.provider, 'tencent-wsa');
  });

  it('enforces the active concurrency limit and runs queued jobs after a slot frees', async (t) => {
    const started = [];
    let running = 0;
    let maximum = 0;
    const service = createService({ concurrency: 2, generate: async () => {
      const gate = deferred();
      running += 1;
      maximum = Math.max(maximum, running);
      started.push(gate);
      await gate.promise;
      running -= 1;
      return fakeResult();
    } });
    t.after(() => { for (const gate of started) gate.resolve(); service.close(); });
    const tasks = await Promise.all(Array.from({ length: 4 }, () => service.createJob(request())));
    await waitFor(() => started.length === 2);
    assert.equal(service.readJob(tasks[2].jobId).stage, 'QUEUED');
    assert.equal(service.readJob(tasks[3].jobId).stage, 'QUEUED');
    started[0].resolve();
    await waitFor(() => started.length === 3);
    assert.equal(maximum, 2);
    started[1].resolve();
    await waitFor(() => started.length === 4);
    started[2].resolve();
    started[3].resolve();
    const jobs = await Promise.all(tasks.map(({ jobId }) => completedJob(service, jobId)));
    assert.ok(jobs.every(({ status }) => status === 'COMPLETED'));
    assert.equal(maximum, 2);
  });

  it('pins a shared configuration ID even after a newer configuration is loaded', async (t) => {
    let time = Date.parse('2026-09-29T00:00:00.000Z');
    let loads = 0;
    const service = createService({ now: () => time,
      loadConfiguration: async () => configuration(++loads),
      generate: async (_body, { systemPrompt }) => fakeResult({ appliedPrompt: systemPrompt }),
    });
    t.after(() => service.close());
    const first = await service.getConfiguration();
    const same = await service.getConfiguration();
    assert.equal(first.configurationId, same.configurationId);
    assert.equal(loads, 1);
    time += 40_000;
    const next = await service.getConfiguration();
    assert.notEqual(first.configurationId, next.configurationId);
    const oldTask = await service.createJob(request({ configurationId: first.configurationId }));
    const newTask = await service.createJob(request({ configurationId: next.configurationId }));
    const oldJob = await completedJob(service, oldTask.jobId);
    const newJob = await completedJob(service, newTask.jobId);
    assert.equal(oldJob.result.configurationId, first.configurationId);
    assert.equal(oldJob.result.appliedPrompt, configuration(1).systemPrompt);
    assert.equal(newJob.result.appliedPrompt, configuration(2).systemPrompt);
    assert.equal(loads, 2);
  });

  it('rejects missing, failed, mismatched research and expired configuration before model calls', async (t) => {
    let clientCalls = 0;
    const service = createService({ createClient: async () => { clientCalls += 1; assert.fail('无效请求不得调用模型'); } });
    t.after(() => service.close());
    for (const body of [
      request({ research: null }), request({ research: research('另一 Query') }),
      request({ research: { ...research(), status: 'FAILED', provider: null, sources: [] } }),
      request({ configurationId: randomUUID() }), request({ generation: { provider: 'unknown' } }),
    ]) await assert.rejects(service.createJob(body));
    assert.equal(clientCalls, 0);
  });

  it('identifies a configuration that expired by time before creating a model job', async (t) => {
    let time = Date.parse('2026-09-29T00:00:00.000Z');
    let clientCalls = 0;
    let generationCalls = 0;
    const service = createService({ now: () => time, retentionMs: 60_000,
      createClient: async () => { clientCalls += 1; return { client: {}, secrets: [] }; },
      generate: async () => { generationCalls += 1; return fakeResult(); },
    });
    t.after(() => service.close());
    const config = await service.getConfiguration();
    time += 60_001;
    await assert.rejects(service.createJob(request({ configurationId: config.configurationId })),
      error => error instanceof TypeError && error.code === 'COPY_CONFIGURATION_EXPIRED');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clientCalls, 0);
    assert.equal(generationCalls, 0);
  });

  it('identifies a configuration from a previous service instance without model calls', async (t) => {
    const previousService = createService();
    const previousConfig = await previousService.getConfiguration();
    previousService.close();
    let clientCalls = 0;
    let generationCalls = 0;
    const service = createService({
      createClient: async () => { clientCalls += 1; return { client: {}, secrets: [] }; },
      generate: async () => { generationCalls += 1; return fakeResult(); },
    });
    t.after(() => service.close());
    await assert.rejects(service.createJob(request({ configurationId: previousConfig.configurationId })),
      error => error instanceof TypeError && error.code === 'COPY_CONFIGURATION_EXPIRED');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clientCalls, 0);
    assert.equal(generationCalls, 0);
  });

  it('shares the refreshed configuration across concurrent retries after expiration', async (t) => {
    let time = Date.parse('2026-09-29T00:00:00.000Z');
    let loads = 0;
    let clientCalls = 0;
    const refreshing = deferred();
    const service = createService({ now: () => time, retentionMs: 60_000,
      loadConfiguration: async () => {
        loads += 1;
        return loads === 1 ? configuration(1) : refreshing.promise;
      },
      createClient: async () => { clientCalls += 1; return { client: {}, secrets: [] }; },
      generate: async (_body, { systemPrompt }) => fakeResult({ appliedPrompt: systemPrompt }),
    });
    t.after(() => { refreshing.resolve(configuration(2)); service.close(); });
    const previousConfig = await service.getConfiguration();
    time += 60_001;
    const rejected = await Promise.allSettled(Array.from({ length: 3 },
      () => service.createJob(request({ configurationId: previousConfig.configurationId }))));
    assert.ok(rejected.every(outcome => outcome.status === 'rejected'
      && outcome.reason.code === 'COPY_CONFIGURATION_EXPIRED'));
    assert.equal(clientCalls, 0);
    const reads = Array.from({ length: 3 }, () => service.getConfiguration());
    await waitFor(() => loads === 2);
    refreshing.resolve(configuration(2));
    const currentConfigs = await Promise.all(reads);
    assert.ok(currentConfigs.every(config => config.configurationId === currentConfigs[0].configurationId));
    assert.notEqual(currentConfigs[0].configurationId, previousConfig.configurationId);
    const submissions = await Promise.all(currentConfigs.map(config => service.createJob(request({
      configurationId: config.configurationId,
    }))));
    const completed = await Promise.all(submissions.map(({ jobId }) => completedJob(service, jobId)));
    assert.ok(completed.every(job => job.status === 'COMPLETED'
      && job.result.configurationId === currentConfigs[0].configurationId
      && job.result.appliedPrompt === configuration(2).systemPrompt));
    assert.equal(clientCalls, 3);
    assert.equal(loads, 2);
  });

  it('redacts submitted and environment keys from events, output, trace, and errors', async (t) => {
    const service = createService({ generate: async (_body, options) => {
      options.onStageChange('ORIGINAL_GENERATION', { note: `${API_KEY} ${ENV_SECRET}` });
      return fakeResult({ copy: { title: API_KEY, body: ENV_SECRET },
        promptTrace: [{ prompt: `${API_KEY} ${ENV_SECRET}`, rawOutput: API_KEY }] });
    } });
    t.after(() => service.close());
    const { jobId } = await service.createJob(request({ generation: { provider: 'system', key: API_KEY } }));
    const job = await completedJob(service, jobId);
    assert.equal(job.status, 'COMPLETED');
    assert.doesNotMatch(JSON.stringify(job), new RegExp(`${API_KEY}|${ENV_SECRET}`, 'u'));
    assert.equal(job.events[0].details.note, '[REDACTED] [REDACTED]');
    const exposed = service.readJob(jobId);
    exposed.result.copy.title = '外部修改';
    assert.equal(service.readJob(jobId).result.copy.title, '[REDACTED]');
  });

  it('redacts submitted keys even when client creation throws before transport exists', async (t) => {
    const service = createService({ createClient: async () => { throw new TypeError(`无效 key ${API_KEY}`); } });
    t.after(() => service.close());
    const { jobId } = await service.createJob(request({ generation: { provider: 'system', key: API_KEY } }));
    const job = await completedJob(service, jobId);
    assert.equal(job.status, 'FAILED');
    assert.doesNotMatch(JSON.stringify(job), new RegExp(API_KEY, 'u'));
    assert.match(job.error.message, /REDACTED/u);
  });

  it('isolates a failed job and retains a REJECTED result when it includes generated copy', async (t) => {
    let calls = 0;
    const service = createService({ concurrency: 1, generate: async () => {
      calls += 1;
      if (calls === 1) throw new Error('模型调用失败');
      return fakeResult({ status: 'REJECTED', review: { decision: 'REJECT' } });
    } });
    t.after(() => service.close());
    const first = await service.createJob(request());
    const second = await service.createJob(request());
    const failed = await completedJob(service, first.jobId);
    const rejected = await completedJob(service, second.jobId);
    assert.equal(failed.status, 'FAILED');
    assert.equal(rejected.status, 'COMPLETED');
    assert.equal(rejected.result.status, 'REJECTED');
    assert.ok(rejected.result.post);
    assert.equal(rejected.result.review.decision, 'REJECT');
  });

  it('passes a timeout AbortSignal to the transport and fails an aborted model call', async (t) => {
    let receivedSignal;
    const service = createService({ timeoutMs: 15,
      createClient: async ({ signal }) => { receivedSignal = signal; return { client: { signal }, secrets: [] }; },
      generate: async (_body, { client }) => {
        await new Promise((_resolve, reject) => client.signal.addEventListener('abort',
          () => reject(client.signal.reason), { once: true }));
        return fakeResult();
      },
    });
    t.after(() => service.close());
    const { jobId } = await service.createJob(request());
    const job = await completedJob(service, jobId);
    assert.equal(receivedSignal.aborted, true);
    assert.equal(job.status, 'FAILED');
  });

  it('returns only public configuration fields and caches login checks', async (t) => {
    let loginChecks = 0;
    const service = createService({ checkLogin: async () => { loginChecks += 1; } });
    t.after(() => service.close());
    const first = await service.getConfiguration();
    await service.getConfiguration();
    assert.equal(loginChecks, 1);
    assert.equal(first.configuration.model, 'openai/fake-model');
    assert.equal(first.configuration.ready, true);
    assert.ok(first.promptInfo.prompts.some(({ kind }) => kind === 'TEXT_SYSTEM'));
    assert.equal(first.productionSettings, undefined);
    assert.equal(first.knowledge, undefined);
    assert.equal(first.environment, undefined);
    assert.doesNotMatch(JSON.stringify(first), new RegExp(ENV_SECRET, 'u'));
  });

  it('enforces job quotas even when concurrent requests wait for the first configuration', async (t) => {
    const loading = deferred();
    const running = deferred();
    const service = createService({ loadConfiguration: () => loading.promise, generate: () => running.promise });
    t.after(() => { running.resolve(fakeResult()); service.close(); });
    const submissions = Array.from({ length: 15 }, () => service.createJob(request()));
    loading.resolve(configuration());
    const outcomes = await Promise.allSettled(submissions);
    assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 12);
    assert.equal(outcomes.filter(({ status }) => status === 'rejected').length, 3);
  });

  it('redacts queued-job metadata and makes queued jobs terminal when the service closes', async (t) => {
    const gate = deferred();
    let started = 0;
    const service = createService({ concurrency: 1, generate: async () => {
      started += 1;
      await gate.promise;
      return fakeResult();
    } });
    t.after(() => { gate.resolve(); service.close(); });
    await service.createJob(request());
    await waitFor(() => started === 1);
    const queryWithKey = `${QUERY} ${API_KEY}`;
    const queued = await service.createJob(request({ query: queryWithKey, research: research(queryWithKey),
      generation: { provider: 'system', key: API_KEY }, researchProvider: { label: API_KEY } }));
    const before = service.readJob(queued.jobId);
    assert.equal(before.stage, 'QUEUED');
    assert.doesNotMatch(JSON.stringify(before), new RegExp(API_KEY, 'u'));
    service.close();
    const after = service.readJob(queued.jobId);
    assert.equal(after.status, 'FAILED');
    assert.ok(after.error);
    assert.equal(started, 1);
  });
});

describe('search lab writing HTTP API', () => {
  it('refreshes expired and unknown configuration IDs before a single model job is created', async (t) => {
    let time = Date.parse('2026-09-29T00:00:00.000Z');
    let clientCalls = 0;
    let generationCalls = 0;
    const service = createService({ now: () => time, retentionMs: 60_000,
      createClient: async () => { clientCalls += 1; return { client: {}, secrets: [] }; },
      generate: async () => { generationCalls += 1; return fakeResult(); },
    });
    const server = createSearchLabServer({ copyService: service });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const config = await (await fetch(`${base}/api/copy-config`)).json();
    time += 60_001;
    let refreshedId;
    for (const configurationId of [config.configurationId, randomUUID()]) {
      const response = await fetch(`${base}/api/copy-jobs`, { method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify(request({ configurationId })),
      });
      assert.equal(response.status, 202);
      const body = await response.json();
      assert.equal(body.configurationRefreshed, true);
      assert.equal(body.configurationId, body.copyConfiguration.configurationId);
      assert.notEqual(body.configurationId, configurationId);
      assert.doesNotMatch(JSON.stringify(body.copyConfiguration), new RegExp(ENV_SECRET, 'u'));
      refreshedId ??= body.configurationId;
      assert.equal(body.configurationId, refreshedId);
      const job = await completedJob(service, body.jobId);
      assert.equal(job.status, 'COMPLETED');
      assert.equal(job.result.configurationId, body.configurationId);
    }
    assert.equal(clientCalls, 2);
    assert.equal(generationCalls, 2);
  });

  it('shares one refreshed configuration across concurrent HTTP requests from an old page', async (t) => {
    let time = Date.parse('2026-09-29T00:00:00.000Z');
    let loads = 0;
    let clientCalls = 0;
    const refreshing = deferred();
    const service = createService({ now: () => time, retentionMs: 60_000,
      loadConfiguration: async () => {
        loads += 1;
        return loads === 1 ? configuration(1) : refreshing.promise;
      },
      createClient: async () => { clientCalls += 1; return { client: {}, secrets: [] }; },
      generate: async (_body, { systemPrompt }) => fakeResult({ appliedPrompt: systemPrompt }),
    });
    const server = createSearchLabServer({ copyService: service });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { refreshing.resolve(configuration(2));
      return new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const previousConfig = await (await fetch(`${base}/api/copy-config`)).json();
    time += 60_001;
    const submissions = Array.from({ length: 3 }, () => fetch(`${base}/api/copy-jobs`, {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify(request({ configurationId: previousConfig.configurationId })),
    }));
    await waitFor(() => loads === 2);
    refreshing.resolve(configuration(2));
    const responses = await Promise.all(submissions);
    assert.ok(responses.every(response => response.status === 202));
    const created = await Promise.all(responses.map(response => response.json()));
    assert.ok(created.every(body => body.configurationRefreshed === true
      && body.configurationId === created[0].configurationId
      && body.copyConfiguration.configurationId === created[0].configurationId));
    assert.notEqual(created[0].configurationId, previousConfig.configurationId);
    const jobs = await Promise.all(created.map(({ jobId }) => completedJob(service, jobId)));
    assert.ok(jobs.every(job => job.result.configurationId === created[0].configurationId
      && job.result.appliedPrompt === configuration(2).systemPrompt));
    assert.equal(clientCalls, 3);
    assert.equal(loads, 2);
  });

  it('returns the structured expiration error when the single retry also expires', async (t) => {
    let creationCalls = 0;
    let configurationCalls = 0;
    const initialId = randomUUID();
    const refreshedId = randomUUID();
    const submittedIds = [];
    const server = createSearchLabServer({ copyService: {
      async createJob(body) {
        creationCalls += 1;
        submittedIds.push(body.configurationId);
        throw Object.assign(new TypeError('生成配置已过期，请刷新生成设置后重试'), {
          code: 'COPY_CONFIGURATION_EXPIRED',
        });
      },
      async getConfiguration() { configurationCalls += 1; return { configurationId: refreshedId }; },
      close() {},
    } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/copy-jobs`, { method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify(request({ configurationId: initialId })),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'COPY_CONFIGURATION_EXPIRED');
    assert.equal(creationCalls, 2);
    assert.equal(configurationCalls, 1);
    assert.deepEqual(submittedIds, [initialId, refreshedId]);
  });

  it('does not refresh or resubmit when job creation fails for another reason', async (t) => {
    let creationCalls = 0;
    let configurationCalls = 0;
    const server = createSearchLabServer({ copyService: {
      async createJob(body) {
        creationCalls += 1;
        if (body.input?.referenceText === 'bad-request') throw new TypeError('无效搜索资料');
        throw new Error('连接状态不明');
      },
      async getConfiguration() { configurationCalls += 1; return { configurationId: randomUUID() }; },
      close() {},
    } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [referenceText, status] of [['bad-request', 400], ['transport-failure', 500]]) {
      const response = await fetch(`${base}/api/copy-jobs`, { method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify(request({ configurationId: randomUUID(), input: { referenceText } })),
      });
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(typeof body.error, 'string');
      assert.equal(body.code, undefined);
    }
    assert.equal(creationCalls, 2);
    assert.equal(configurationCalls, 0);
  });

  it('returns public config, creates async jobs, serves status, and applies local request gates', async (t) => {
    const service = createService();
    const server = createSearchLabServer({ copyService: service, compare: async () => ({ results: [] }) });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const configResponse = await fetch(`${base}/api/copy-config`);
    assert.equal(configResponse.status, 200);
    assert.equal(configResponse.headers.get('cache-control'), 'no-store');
    const config = await configResponse.json();
    assert.ok(config.configurationId);
    assert.doesNotMatch(JSON.stringify(config), new RegExp(ENV_SECRET, 'u'));
    const created = await fetch(`${base}/api/copy-jobs`, { method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify(request({ configurationId: config.configurationId })),
    });
    assert.equal(created.status, 202);
    const { jobId } = await created.json();
    await completedJob(service, jobId);
    const status = await fetch(`${base}/api/copy-jobs/${jobId}`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).status, 'COMPLETED');
    const missing = await fetch(`${base}/api/copy-jobs/${randomUUID()}`);
    assert.equal(missing.status, 404);
    const deniedOrigin = await fetch(`${base}/api/copy-jobs`, { method: 'POST',
      headers: { Origin: 'https://example.org', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(deniedOrigin.status, 403);
    const deniedType = await fetch(`${base}/api/copy-jobs`, { method: 'POST',
      headers: { Origin: base, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(deniedType.status, 403);
    assert.equal(await requestWithHost(`${base}/api/copy-config`, 'example.org'), 403);
    const invalid = await fetch(`${base}/api/copy-jobs`, { method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(invalid.status, 400);
  });
});
