import { createCodexClient } from './codex.mjs';
import { createOpenClawClient } from './openclaw.mjs';
import { effectiveModelApiConfig } from './model-api-config.mjs';

export function createAgentClient(options = {}) {
  const config = effectiveModelApiConfig(options.modelApi ?? {}, options.environment ?? process.env);
  return config.agentProvider === 'CODEX'
    ? createCodexClient(options)
    : { provider: 'openclaw', ...createOpenClawClient(options) };
}
