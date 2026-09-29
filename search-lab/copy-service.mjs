import { randomUUID } from 'node:crypto';
import { checkCodexLogin } from '../src/codex-process.mjs';
import { createCopyGenerationClient } from '../src/copy-generation-client.mjs';
import { effectiveModelApiConfig, validatedDotsModel } from '../src/model-api-config.mjs';
import { PROMPT_CATALOG } from '../src/prompt-catalog.mjs';
import { defaultBusinessPrompt } from '../src/prompt-runtime.mjs';
import { loadCopyConfiguration } from './copy-config.mjs';
import { generateLabCopy, validateGenerateRequest } from './generate.mjs';

const COPY_PROMPT_KINDS = new Set(['TEXT_SYSTEM', 'COPY_IMAGE_PLAN_SYSTEM',
  'QUERY_REVIEW_SYSTEM', 'TEXT_REVIEW_SYSTEM', 'COPY_LENGTH_REPAIR_SYSTEM',
  'COPY_REPAIR_SYSTEM', 'COPY_REVISION_SYSTEM', 'COPY_KNOWLEDGE_MATCH_SYSTEM',
  'COPY_KNOWLEDGE_USE_SYSTEM']);
const TERMINAL = new Set(['COMPLETED', 'FAILED']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function environmentSecrets(environment) {
  return Object.entries(environment).filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD/iu.test(name)
    && typeof value === 'string' && value.length >= 4).map(([, value]) => value);
}

function redact(value, secrets) {
  if (typeof value === 'string') return secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value);
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]));
  return value;
}

function generationOptions(raw = {}) {
  if (!isRecord(raw)) throw new TypeError('生成模型配置格式不正确');
  const provider = raw.provider ?? 'system';
  if (!['system', 'dots'].includes(provider)) throw new TypeError('不支持的文案生成模型');
  const key = raw.key == null ? '' : typeof raw.key === 'string' ? raw.key.trim() : null;
  if (key === null || key.length > 2_000 || /\s/u.test(key) || (key && key.length < 4)) {
    throw new TypeError('文案模型 Key 格式不正确');
  }
  const model = provider === 'dots' ? validatedDotsModel(raw.model) : null;
  return { provider, key, model };
}

export function createLabGenerationClient({ generation, configuration, environment = process.env, signal } = {}) {
  const options = generationOptions(generation);
  const modelApi = { ...(configuration.productionSettings?.modelApi ?? {}) };
  const scopedEnvironment = { ...environment };
  if (options.provider === 'dots') {
    modelApi.copyGenerationProvider = 'DOTS';
    modelApi.dotsModel = options.model;
  }
  const effective = effectiveModelApiConfig(modelApi, scopedEnvironment);
  if (effective.copyGenerationProvider === 'DOTS') {
    if (options.key) scopedEnvironment.XHS_DOTS_API_KEY = options.key;
    if (!String(scopedEnvironment.XHS_DOTS_API_KEY ?? '').trim()) {
      throw new TypeError('请在生成设置中填写 Dots API Key');
    }
  }
  const source = createCopyGenerationClient({ modelApi, environment: scopedEnvironment });
  return {
    client: {
      runText: input => source.runText({ ...input, signal }),
      runReview: input => source.runReview({ ...input, signal }),
    },
    secrets: [...environmentSecrets(scopedEnvironment), options.key].filter(Boolean),
    model: effective.copyGenerationProvider === 'DOTS' ? effective.dotsModel : effective.textModel,
    reviewModel: effective.reviewModel,
    thinking: effective.copyGenerationThinking,
    provider: effective.copyGenerationProvider,
  };
}

export function publicCopyConfiguration(configuration, { environment = process.env, loginReady = true } = {}) {
  const model = effectiveModelApiConfig(configuration.productionSettings?.modelApi ?? {}, environment);
  const isDots = model.copyGenerationProvider === 'DOTS';
  const hasKey = Boolean(String(environment.XHS_DOTS_API_KEY ?? '').trim());
  return {
    configuration: {
      provider: 'system', label: isDots ? '当前系统 · Dots' : '当前系统 · Codex',
      model: isDots ? model.dotsModel : model.textModel,
      reviewModel: model.reviewModel, thinking: model.copyGenerationThinking,
      ready: isDots ? hasKey : loginReady,
      textReviewEnabled: true, autoReviseOnReject: true,
      warning: [configuration.warning, ...(configuration.warnings ?? []), (!loginReady
        ? '本机 Codex 尚未登录，使用系统模型或自动审核前请完成系统原有登录。'
        : isDots && !hasKey ? '当前系统使用 Dots，请在生成设置中填写它的 Key。' : '')].filter(Boolean).join('；'),
    },
    providers: [
      { id: 'system', label: isDots ? '当前系统 · Dots' : '当前系统 · Codex',
        needsKey: isDots && !hasKey, hasModel: false,
        defaultModel: isDots ? model.dotsModel : model.textModel,
        description: '沿用当前系统生成模型、思考强度与审核模型' },
      { id: 'dots', label: 'Dots · 自定义 Key', needsKey: true, hasModel: true,
        defaultModel: model.dotsModel, description: '生成使用 Dots；自动审核沿用当前系统审核模型' },
    ],
    promptInfo: {
      source: configuration.source, sourceLabel: configuration.sourceLabel ?? configuration.source,
      capturedAt: configuration.promptRuntime?.capturedAt ?? null,
      knowledgeEnabled: configuration.productionSettings?.knowledgeEnabled !== false,
      knowledgeCount: (configuration.knowledge ?? []).filter(item => item.kind === 'COPY').length,
      queryReviewEnabled: configuration.settings?.queryReviewEnabled ?? false,
      prompts: PROMPT_CATALOG.filter(item => COPY_PROMPT_KINDS.has(item.kind)).map(item => {
        const version = configuration.promptRuntime?.prompts?.[item.kind];
        return { kind: item.kind, label: item.label, content: version?.content ?? defaultBusinessPrompt(item.kind),
          version: version?.version ?? null, versionId: version?.versionId ?? null,
          sha256: version?.sha256 ?? null,
          source: version?.source ?? (version ? configuration.source : 'BUNDLED_DEFAULT') };
      }),
    },
  };
}

/** Jobs and their pinned configuration stay in memory; credentials are never persisted. */
export function createCopyLabService({
  environment = process.env,
  loadConfiguration = () => loadCopyConfiguration({ environment }),
  createClient = createLabGenerationClient,
  generate = generateLabCopy,
  checkLogin = () => checkCodexLogin({ environment, timeoutMs: 5_000 }),
  now = () => Date.now(), concurrency = 2, maxJobs = 24,
  retentionMs = 60 * 60 * 1000, timeoutMs = 20 * 60 * 1000,
} = {}) {
  const jobs = new Map();
  const snapshots = new Map();
  const pending = [];
  let active = 0;
  let closed = false;
  let latestConfiguration = null;
  let loadingConfiguration = null;
  let loginCheckedAt = null;
  let loginReady = false;

  function prune() {
    for (const [id, job] of jobs) {
      if (TERMINAL.has(job.status) && now() - job.finishedAt > retentionMs) jobs.delete(id);
    }
    for (const [id, snapshot] of snapshots) {
      if (now() - snapshot.createdAt > retentionMs) snapshots.delete(id);
    }
  }

  async function loadSnapshot() {
    prune();
    if (latestConfiguration && now() - latestConfiguration.createdAt < 30_000) return latestConfiguration;
    if (!loadingConfiguration) loadingConfiguration = Promise.resolve().then(loadConfiguration).then(configuration => {
      const snapshot = { id: randomUUID(), configuration, createdAt: now() };
      snapshots.set(snapshot.id, snapshot);
      while (snapshots.size > maxJobs) snapshots.delete(snapshots.keys().next().value);
      latestConfiguration = snapshot;
      return snapshot;
    }).finally(() => { loadingConfiguration = null; });
    return loadingConfiguration;
  }

  async function getConfiguration() {
    const snapshot = await loadSnapshot();
    if (loginCheckedAt === null || now() - loginCheckedAt >= 60_000) {
      try { await checkLogin(); loginReady = true; } catch { loginReady = false; }
      loginCheckedAt = now();
    }
    return redact({ ...publicCopyConfiguration(snapshot.configuration, { environment, loginReady }),
      configurationId: snapshot.id }, environmentSecrets(environment));
  }

  function readJob(id) {
    prune();
    const job = jobs.get(id);
    if (!job) return null;
    return structuredClone({ jobId: job.id, status: job.status, stage: job.stage,
      events: job.events, query: job.query, researchProvider: job.researchProvider,
      createdAt: new Date(job.createdAt).toISOString(),
      durationMs: Math.max(0, (job.finishedAt ?? now()) - job.createdAt),
      ...(job.result ? { result: job.result, prompts: job.result.promptTrace ?? [] } : {}),
      ...(job.error ? { error: job.error } : {}),
    });
  }

  async function run(job, work) {
    active += 1;
    job.stage = 'STARTING';
    const controller = new AbortController();
    job.controller = controller;
    const deadline = setTimeout(() => controller.abort(new Error('文案生成超过 20 分钟，请检查模型连接后重试')), timeoutMs);
    deadline.unref?.();
    let secrets = [...environmentSecrets(environment), work.generation.key].filter(Boolean);
    try {
      const transport = await createClient({ generation: work.generation, configuration: work.configuration,
        environment, signal: controller.signal });
      secrets = [...secrets, ...(transport.secrets ?? []), work.generation.key].filter(Boolean);
      const result = await generate(work.body, {
        client: transport.client, promptRuntime: work.configuration.promptRuntime,
        systemPrompt: work.configuration.systemPrompt,
        copyKnowledge: work.configuration.knowledge ?? [], secrets,
        onStageChange(stage, details = {}) {
          job.stage = stage;
          job.events.push(redact({ stage, at: new Date(now()).toISOString(), details }, secrets));
          if (job.events.length > 100) job.events.shift();
        },
      });
      job.result = redact({ ...result, configurationId: work.configurationId,
        generationSettings: { model: transport.model ?? null, reviewModel: transport.reviewModel ?? null,
          provider: transport.provider ?? work.generation.provider, thinking: transport.thinking ?? null } }, secrets);
      job.status = result.status === 'FAILED' || (result.status === 'REJECTED' && !result.post) ? 'FAILED' : 'COMPLETED';
      if (job.status === 'FAILED') job.error = redact(result.error ?? { message: '文案生成未完成' }, secrets);
    } catch (error) {
      job.status = 'FAILED';
      job.error = redact({ message: error instanceof TypeError || error instanceof RangeError
        ? error.message : '文案生成失败，请检查当前系统模型连接与登录状态',
      ...(typeof error?.code === 'string' ? { code: error.code } : {}) }, secrets);
    } finally {
      clearTimeout(deadline);
      job.finishedAt = now();
      delete job.controller;
      active -= 1;
      pump();
    }
  }

  function pump() {
    if (closed) return;
    while (active < concurrency && pending.length) {
      const { job, work } = pending.shift();
      void run(job, work);
    }
  }

  async function createJob(body) {
    if (closed) throw new TypeError('测试站正在停止，请稍后重试');
    const request = validateGenerateRequest(body);
    if (!request.researchSnapshot) throw new TypeError('请先完成搜索，再选择成功的搜索资料生成文案');
    const generation = generationOptions(body.generation);
    const snapshot = body.configurationId ? snapshots.get(body.configurationId) : await loadSnapshot();
    prune();
    if (!snapshot || now() - snapshot.createdAt > retentionMs) {
      throw Object.assign(new TypeError('生成配置已过期，请刷新生成设置后重试'), {
        code: 'COPY_CONFIGURATION_EXPIRED',
      });
    }
    if ([...jobs.values()].filter(job => job.status === 'RUNNING').length >= 12) {
      throw new RangeError('已有 12 个文案任务正在处理，请等待完成');
    }
    if (jobs.size >= maxJobs) {
      const oldest = [...jobs.values()].find(job => TERMINAL.has(job.status));
      if (oldest) jobs.delete(oldest.id);
      else throw new RangeError('文案任务已满，请等待完成');
    }
    const publicSecrets = [...environmentSecrets(environment), generation.key].filter(Boolean);
    const job = { id: randomUUID(), status: 'RUNNING', stage: 'QUEUED', events: [],
      createdAt: now(), query: redact(request.query, publicSecrets),
      researchProvider: { id: request.researchSnapshot.provider,
        label: redact(String(body.researchProvider?.label ?? request.researchSnapshot.provider).slice(0, 100), publicSecrets) } };
    jobs.set(job.id, job);
    // Whitelist request data so submitted API keys are not retained in job results.
    const writingBody = { query: request.query, input: request.input,
      researchSnapshot: request.researchSnapshot, requestedImageCount: request.imageCount,
      textReviewEnabled: request.textReviewEnabled, autoReviseOnReject: request.autoReviseOnReject };
    pending.push({ job, work: { body: writingBody, generation, configuration: snapshot.configuration, configurationId: snapshot.id } });
    setImmediate(pump);
    return { jobId: job.id, configurationId: snapshot.id };
  }

  function close() {
    closed = true;
    for (const job of jobs.values()) job.controller?.abort(new Error('测试站已停止'));
    for (const { job } of pending) {
      job.status = 'FAILED';
      job.finishedAt = now();
      job.error = { message: '测试站已停止，本次排队文案未执行' };
    }
    pending.length = 0;
  }

  return { getConfiguration, createJob, readJob, close };
}
