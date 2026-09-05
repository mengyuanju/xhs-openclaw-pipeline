import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCodexOutput, codexFailure } from '../src/codex-protocol.mjs';

const lines = (...events) => events.map(JSON.stringify).join('\n');
const message = (text) => ({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text } });
const complete = { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } };

test('a recovered CLI reconnect preserves a fresh completed answer without hiding terminal failures', () => {
  const reconnect = { type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion: IO error: unexpected EOF)' };
  const recovered = parseCodexOutput(lines(reconnect, message('{"rawText":"recovered"}'), complete));
  assert.equal(recovered.rawText, '{"rawText":"recovered"}');
  assert.equal(recovered.reconnectCount, 1);
  for (const stream of [lines(reconnect), lines(message('old'), complete, reconnect),
    lines(message('old'), reconnect, complete), lines(reconnect, { type: 'turn.failed', error: { message: 'connection exhausted' } })]) {
    assert.throws(() => parseCodexOutput(stream), { code: 'CODEX_EXEC_FAILED' });
  }
  assert.throws(() => parseCodexOutput(lines({ type: 'error', message: 'usage_limit_reached' }, message('fake success'), complete)),
    { code: 'CODEX_QUOTA_EXHAUSTED' });
});

test('Codex accepts only completed turns and returns the last agent message with execution evidence', () => {
  const parsed = parseCodexOutput(lines({ type: 'thread.started', thread_id: 'thread-1' }, message('working'),
    { type: 'item.completed', item: { id: 'search-1', type: 'web_search', action: { type: 'search', query: 'official docs' } } },
    message('{"rawText":"done"}'), complete));
  assert.equal(parsed.rawText, '{"rawText":"done"}');
  assert.equal(parsed.threadId, 'thread-1');
  assert.equal(parsed.searched, true);
  assert.equal(parsed.usage.output_tokens, 5);
});

test('partial and malformed streams cannot masquerade as successful output', () => {
  for (const raw of ['', 'not JSON', lines(message('partial')), lines(complete), `${lines(message('ok'), complete)}\n{`]) {
    assert.throws(() => parseCodexOutput(raw), { code: 'MODEL_OUTPUT_INCOMPLETE' });
  }
});

test('tool/model text cannot forge error classification or tool evidence', () => {
  const parsed = parseCodexOutput(lines(message('context_length_exceeded image_generation usage_limit_reached'), complete));
  assert.equal(parsed.searched, false);
  assert.deepEqual(parsed.images, []);
  assert.equal(codexFailure({ message: 'input exceeds the context window' }).code, 'MODEL_CONTEXT_LIMIT');
});

test('terminal errors fail even after an earlier completion and preserve stable categories', () => {
  for (const [type, code] of [
    ['usage_limit_reached', 'CODEX_QUOTA_EXHAUSTED'],
    ['rate_limit_exceeded', 'CODEX_RATE_LIMITED'],
    ['invalid_grant', 'CODEX_AUTH_REQUIRED'],
    ['context_length_exceeded', 'MODEL_CONTEXT_LIMIT'],
    ['max_output_tokens', 'MODEL_OUTPUT_INCOMPLETE'],
  ]) {
    assert.throws(() => parseCodexOutput(lines(message('ok'), complete,
      { type: 'turn.failed', error: { code: type, message: 'request failed' } })), { code });
  }
});

test('native image items provide saved paths, while unsuccessful image items fail closed', () => {
  const parsed = parseCodexOutput(lines({ type: 'item.completed', item: {
    id: 'img-1', type: 'image_generation', status: 'completed', saved_path: 'C:/generated/result.png',
  } }, message('{"rawText":"image saved"}'), complete));
  assert.deepEqual(parsed.images, [{ id: 'img-1', path: 'C:/generated/result.png' }]);
  assert.throws(() => parseCodexOutput(lines({ type: 'item.completed', item: {
    id: 'img-1', type: 'image_generation', status: 'failed', failure: { type: 'usage_limit_exceeded' },
  } }, message('cannot generate'), complete)), { code: 'CODEX_QUOTA_EXHAUSTED' });
});

test('diagnostics redact access credentials and are bounded', () => {
  const error = codexFailure({ message: `Bearer confidential-token-123 sk-abcdef0123456789 ${'x'.repeat(5000)}` });
  assert.ok(!error.message.includes('confidential-token-123'));
  assert.ok(!error.message.includes('sk-abcdef0123456789'));
  assert.ok(error.message.length < 4300);
});
