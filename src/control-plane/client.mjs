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
    payload = await response.json().catch(() => null);
  }
  if (!response.ok) {
    throw new ControlPlaneApiError(
      response.status,
      payload?.error?.code ?? 'CONTROL_PLANE_ERROR',
      payload?.error?.message ?? `control plane returned HTTP ${response.status}`,
    );
  }
  return payload?.data;
}

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

  return {
    health: () => request('/health'),
    registerNode: (input) => request('/v1/nodes', { method: 'POST', body: input }),
    createTasks: (input) => request('/v1/tasks', { method: 'POST', body: input }),
    listTasks: ({ state, nodeId, limit = 50, offset = 0 } = {}) => {
      const search = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (state) search.set('state', state);
      if (nodeId) search.set('nodeId', nodeId);
      return request(`/v1/tasks?${search}`);
    },
    getTask: (taskId) => request(`/v1/tasks/${taskId}`),
    claimCopy: (nodeId) => request('/v1/executions/claim-copy', {
      method: 'POST', body: { nodeId },
    }),
    claimImage: (nodeId) => request('/v1/executions/claim-image', {
      method: 'POST', body: { nodeId },
    }),
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
    failExecution: (executionId, error) => request(
      `/v1/executions/${executionId}/fail`,
      { method: 'POST', body: { error: error instanceof Error ? error.message : String(error) } },
    ),
    approveCopy: (taskId, input) => request(`/v1/tasks/${taskId}/approve-copy`, {
      method: 'POST', body: input,
    }),
    retryTask: (taskId, input = {}) => request(`/v1/tasks/${taskId}/retry`, {
      method: 'POST', body: input,
    }),
    approveDelivery: (taskId) => request(`/v1/tasks/${taskId}/approve-delivery`, {
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
