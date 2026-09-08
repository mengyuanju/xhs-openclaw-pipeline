import { createCodexClient } from './codex.mjs';

export function createAgentClient(options = {}) {
  return createCodexClient(options);
}
