import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { codexFailure } from './codex-protocol.mjs';
import { terminateCodexTree } from './codex-process.mjs';

// Codex 0.152 exec JSONL omits imageGeneration items. The versioned app-server
// protocol retains native savedPath evidence; never infer it from agent prose.
export async function runCodexImageProcess(command, args, { input = '', cwd, env, timeoutMs = 300_000,
  signal, onSpawn, maxBuffer = 32 * 1024 * 1024, spawnImpl = spawn } = {}) {
  signal?.throwIfAborted();
  const flag = key => args[args.indexOf(key) + 1];
  const configuration = {};
  for (let i = 0; i < args.length; i++) if (args[i] === '-c') {
    const entry = args[++i], split = entry.indexOf('=');
    configuration[entry.slice(0, split)] = JSON.parse(entry.slice(split + 1));
  }
  const outputSchema = JSON.parse(await readFile(flag('--output-schema'), 'utf8'));
  const attachments = args.flatMap((arg, index) => arg === '--image' ? [{ type: 'localImage', path: args[index + 1] }] : []);
  return new Promise(resolve => {
    const child = spawnImpl(command, ['-c', 'forced_login_method="chatgpt"', 'app-server', '--stdio'], {
      cwd, env, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '', rawStdout = '', stderr = '', bytes = 0, failure, termination, closing = false;
    let threadId, turnId, usage = null, exitTimer;
    const events = [], items = new Map();
    const send = value => { if (!closing) child.stdin.write(JSON.stringify(value) + '\n'); };
    function stop(error) {
      failure ??= error;
      if (!termination) termination = terminateCodexTree(child);
      closing = true;
    }
    const abort = () => stop(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    const timer = setTimeout(() => stop(codexFailure({ message: 'image call timed out; outcome may be unknown' }, 'CODEX_EXEC_TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    function itemEvent(item) {
      if (!item?.id || items.has(item.id)) return;
      if (item.type === 'imageGeneration') {
        items.set(item.id, { type: 'item.completed', item: { type: 'image_generation', id: item.id,
          status: item.status, saved_path: item.savedPath, failure: item.failure } });
      } else if (item.type === 'agentMessage') {
        items.set(item.id, { type: 'item.completed', item: { type: 'agent_message', id: item.id, text: item.text } });
      }
    }
    function consume(message) {
      if (message.method && message.id !== undefined) {
        // This adapter never executes external tools, grants approvals or supplies credentials.
        send({ id: message.id, error: { code: -32601, message: 'client requests are unsupported by the image adapter' } });
        return;
      }
      if (message.id !== undefined) {
        if (message.error) { stop(codexFailure(message.error)); return; }
        if (message.id === 1) {
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'config/read', params: { includeLayers: false, cwd } });
        } else if (message.id === 2) {
          const loaded = message.result?.config;
          const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
          if (!object(loaded) || (loaded.mcp_servers !== undefined && !object(loaded.mcp_servers))) {
            stop(codexFailure({ message: 'invalid config/read response; cannot isolate configured MCP servers' })); return;
          }
          const servers = loaded.mcp_servers ?? {};
          const config = { ...configuration };
          // Explicit dotted overrides disable every configured MCP server on this thread.
          for (const name of Object.keys(servers)) config[`mcp_servers.${name}.enabled`] = false;
          send({ id: 3, method: 'thread/start', params: { model: flag('--model'), cwd, ephemeral: true,
            sandbox: 'read-only', approvalPolicy: 'never', config, selectedCapabilityRoots: [],
            developerInstructions: configuration.developer_instructions, allowProviderModelFallback: false } });
        } else if (message.id === 3) {
          threadId = message.result?.thread?.id;
          if (typeof threadId !== 'string' || !threadId) { stop(codexFailure({ message: 'missing thread ID' })); return; }
          events.push({ type: 'thread.started', thread_id: threadId });
          send({ id: 4, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: input }, ...attachments],
            model: flag('--model'), effort: configuration.model_reasoning_effort, approvalPolicy: 'never', outputSchema } });
        } else if (message.id === 4) turnId ??= message.result?.turn?.id;
        return;
      }
      const params = message.params;
      if (!threadId || params?.threadId !== threadId) return;
      if (message.method === 'turn/started') { turnId ??= params.turn?.id; return; }
      if (message.method === 'thread/tokenUsage/updated') { usage = params.tokenUsage?.last ?? null; return; }
      if (message.method === 'item/completed' && turnId && params.turnId === turnId) itemEvent(params.item);
      if (message.method === 'error' && turnId && params.turnId === turnId) {
        events.push({ type: params.willRetry ? 'warning' : 'error', error: params.error, will_retry: params.willRetry === true });
      }
      if (message.method === 'turn/completed' && turnId && params.turn?.id === turnId) {
        for (const item of params.turn.items ?? []) itemEvent(item);
        events.push(...items.values());
        events.push(params.turn.status === 'completed' ? { type: 'turn.completed', usage }
          : { type: 'turn.failed', error: params.turn.error ?? { message: `turn ${params.turn.status}` } });
        closing = true;
        child.stdin.end();
        // Bound app-server shutdown while retaining the permit until the process tree exits.
        exitTimer = setTimeout(() => { if (!termination) termination = terminateCodexTree(child); }, 3000);
      }
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBuffer) { stop(codexFailure({ message: 'image protocol exceeded buffer limit' }, 'CODEX_OUTPUT_TOO_LARGE')); return; }
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary).trim(); buffer = buffer.slice(boundary + 1);
        if (!line || closing) continue;
        let message;
        try { message = JSON.parse(line); } catch {
          // Setup output can contain partially serialized user configuration.
          rawStdout = (rawStdout + (threadId ? line : '[malformed setup protocol omitted]') + '\n').slice(-64000);
          stop(codexFailure({ message: 'invalid image protocol JSON' })); continue;
        }
        // Handshake responses include user MCP config (env, headers, arbitrary args).
        // Never retain their contents; record only task protocol notifications verbatim.
        const diagnostic = message.id !== undefined ? JSON.stringify({ id: message.id, responseOmitted: true })
          : threadId && message.params?.threadId === threadId ? line : JSON.stringify({ method: message.method, payloadOmitted: true });
        rawStdout = (rawStdout + diagnostic + '\n').slice(-64000);
        try { consume(message); } catch { stop(codexFailure({ message: 'invalid image protocol payload' })); }
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error); });
    child.once('error', error => { failure ??= error; });
    child.once('spawn', () => {
      try {
        onSpawn?.(child.pid);
        if (signal?.aborted) { abort(); return; }
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'xhs_image_adapter', version: '0.2.0' },
          capabilities: { experimentalApi: true } } });
      } catch (error) { stop(error); }
    });
    child.once('close', async status => {
      clearTimeout(timer); clearTimeout(exitTimer); signal?.removeEventListener('abort', abort);
      await termination;
      const completed = events.some(event => event.type === 'turn.completed' || event.type === 'turn.failed');
      resolve({ status: !failure && completed ? 0 : status ?? 1, stdout: events.map(JSON.stringify).join('\n'), rawStdout, stderr,
        error: failure ?? (!completed ? codexFailure({ message: 'image process exited before completing a turn' }) : undefined) });
    });
  });
}
