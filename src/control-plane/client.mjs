export class ControlPlaneApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ControlPlaneApiError';
    this.status = status;
    this.code = code;
  }
}

function normalizedBaseUrl(value) {
  const url = new URL(String(value ?? ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('control plane URL must be an HTTP(S) URL without credentials');
  }
  url.pathname = url.pathname.replace(/\/$/u, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/u, '');
}

async function responseData(response) {
  const contentType = response.headers.get('content-type') ?? '';
  let payload = null;
  if (contentType.includes('application/json')) {
    try {
      payload = await response.json();
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw error;
      // A successful HTTP status with a broken body is not an empty queue.
      // Leave payload null so malformed upstream bodies never enter error messages.
    }
  }
  if (!response.ok) {
    throw new ControlPlaneApiError(
      response.status,
      payload?.error?.code ?? 'CONTROL_PLANE_ERROR',
      payload?.error?.message ?? `control plane returned HTTP ${response.status}`,
    );
  }
  if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'data')) {
    throw new ControlPlaneApiError(
      502, 'INVALID_CONTROL_PLANE_RESPONSE', '中心服务响应不完整或格式错误，请检查连接后重试',
    );
  }
  return payload.data;
}

/** @param {{ baseUrl: string, fetchImpl?: typeof fetch, requestTimeoutMs?: number }} options */
export function createControlPlaneClient({
  baseUrl,
  fetchImpl = fetch,
  requestTimeoutMs = 30_000,
} = {}) {
  const root = normalizedBaseUrl(baseUrl);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  async function request(path, { method = 'GET', body, headers = {}, timeoutMs = requestTimeoutMs } = {}) {
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers: {
        ...(body === undefined || Buffer.isBuffer(body) ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return responseData(response);
  }

  /** @param {'COPY'|'IMAGE'} kind @param {{nodeId: string, limit: number, requestId: string}} input */
  async function claimBatch(kind, input) {
    const result = await request(`/v1/executions/claim-${kind.toLowerCase()}-batch`, { method: 'POST', body: input });
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
    const valid = result?.requestId === input.requestId && Array.isArray(result.claims)
      && result.claims.length <= input.limit && result.claims.every(({ task, execution } = {}) =>
        Number.isSafeInteger(task?.id) && task.id > 0 && uuid.test(execution?.id)
        && execution.taskId === task.id && execution.nodeId === input.nodeId && execution.kind === kind
        && ['RUNNING', 'SUCCEEDED', 'FAILED', 'ABANDONED'].includes(execution.status));
    if (!valid || new Set(result.claims.map(claim => claim.execution.id)).size !== result.claims.length) {
      throw new ControlPlaneApiError(502, 'INVALID_CONTROL_PLANE_RESPONSE', '中心批量领取响应不完整，请使用原请求 ID 重试');
    }
    return result;
  }

  return {
    health: () => request('/health'),
    registerNode: (input) => request('/v1/nodes', { method: 'POST', body: input }),
    listNodes: () => request('/v1/nodes'),
    createTasks: (input) => request('/v1/tasks', { method: 'POST', body: input }),
    listTasks: ({ state, states, nodeId, query, limit = 50, offset = 0, includeTotal = false } = {}) => {
      const search = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (state) search.set('state', state);
      if (states) search.set('states', Array.isArray(states) ? states.join(',') : states);
      if (nodeId) search.set('nodeId', nodeId);
      if (query) search.set('query', query);
      if (includeTotal) search.set('includeTotal', 'true');
      return request(`/v1/tasks?${search}`);
    },
    taskCounts: (nodeId) => request(`/v1/task-counts?${new URLSearchParams({ nodeId: String(nodeId) })}`),
    getTask: (taskId) => request(`/v1/tasks/${taskId}`),
    recordModelCall: (executionId, callId, record) => request(
      `/v1/executions/${executionId}/model-calls/${callId}`,
      { method: 'PUT', body: record, timeoutMs: 5_000 },
    ),
    claimCopy: (nodeId) => request('/v1/executions/claim-copy', {
      method: 'POST', body: { nodeId },
    }),
    claimImage: (nodeId) => request('/v1/executions/claim-image', {
      method: 'POST', body: { nodeId },
    }),
    claimCopyBatch: (input) => claimBatch('COPY', input),
    claimImageBatch: (input) => claimBatch('IMAGE', input),
    updateProgress: (executionId, progress) => request(
      `/v1/executions/${executionId}/progress`,
      { method: 'PATCH', body: progress },
    ),
    completeCopy: (executionId, result) => request(
      `/v1/executions/${executionId}/complete-copy`,
      { method: 'POST', body: { result }, timeoutMs: 60_000 },
    ),
    completeImage: (executionId, result) => request(
      `/v1/executions/${executionId}/complete-image`,
      { method: 'POST', body: { result }, timeoutMs: 60_000 },
    ),
    async failExecution(executionId, error, { autoRetry } = {}) {
      const message = error instanceof Error ? error.message : String(error);
      if (autoRetry !== undefined && typeof autoRetry !== 'boolean') throw new TypeError('autoRetry must be a boolean');
      const policy = autoRetry === undefined ? {} : { autoRetry };
      const path = `/v1/executions/${executionId}/fail`;
      try {
        return await request(path, { method: 'POST', body: { error: message, ...policy } });
      } catch (reportError) {
        // Older servers copied the full error into progress_message varchar(500).
        // Keep full diagnostics on upgraded servers; retry only that legacy shape.
        if (reportError.status !== 500 || reportError.code !== 'INTERNAL_ERROR'
          || [...message].length <= 500) throw reportError;
        return request(path, {
          method: 'POST',
          body: { error: [...message].slice(0, 499).join('') + '…', ...policy },
        });
      }
    },
    approveCopy: (taskId, input) => request(`/v1/tasks/${taskId}/approve-copy`, {
      method: 'POST', body: input,
    }),
    retryTask: (taskId, input = {}) => request(`/v1/tasks/${taskId}/retry`, {
      method: 'POST', body: input,
    }),
    cancelTask: (taskId) => request(`/v1/tasks/${taskId}/cancel`, {
      method: 'POST', body: {},
    }),
    uploadAsset: (executionId, { content, mediaType, fileName }) => request(
      `/v1/executions/${executionId}/assets`,
      {
        method: 'PUT',
        body: Buffer.from(content),
        headers: {
          'Content-Type': mediaType,
          ...(fileName ? { 'X-File-Name': String(fileName).slice(0, 255) } : {}),
        },
        timeoutMs: 120_000,
      },
    ),
    listSettings: () => request('/v1/settings'),
    updateSetting: (key, value) => request(`/v1/settings/${encodeURIComponent(key)}`, {
      method: 'PUT', body: { value },
    }),
    listPrompts: () => request('/v1/prompts'),
    createPromptVersion: (input) => request('/v1/prompts/versions', {
      method: 'POST', body: input,
    }),
    publishPromptVersion: (versionId) => request(`/v1/prompt-versions/${versionId}/publish`, {
      method: 'POST', body: {},
    }),
    listKnowledge: () => request('/v1/knowledge'),
    knowledgeCapabilities: () => request('/v1/knowledge/capabilities'),
    listCopyAnalysisPrompts: () => request('/v1/copy-analysis-prompts'),
    createCopyAnalysisPrompt: (input) => request('/v1/copy-analysis-prompts', { method: 'POST', body: input }),
    replaceCopyAnalysisPrompt: (id, input) => request(`/v1/copy-analysis-prompts/${id}`, { method: 'PATCH', body: input }),
    importCopyKnowledgeLabels: (labels) => request('/v1/knowledge/labels/import', { method: 'POST', body: { labels } }),
    retireKnowledge: (id) => request(`/v1/knowledge/${id}/retire`, { method: 'POST', body: {} }),
    createKnowledgeVersion: (input) => request('/v1/knowledge/versions', {
      method: 'POST', body: input,
    }),
    uploadKnowledgeAsset: (versionId, content) => request(
      `/v1/knowledge-versions/${versionId}/asset`,
      {
        method: 'PUT',
        body: Buffer.from(content),
        headers: { 'Content-Type': 'image/png' },
        timeoutMs: 120_000,
      },
    ),
    publishKnowledgeVersion: (versionId) => request(
      `/v1/knowledge-versions/${versionId}/publish`,
      { method: 'POST', body: {} },
    ),
  };
}
