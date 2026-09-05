import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
const scenario = process.argv[2];
const threadId = '11111111-1111-7111-8111-111111111111', turnId = 'turn-a';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const image = { id: 'native', type: 'imageGeneration', status: 'completed', savedPath: '/generated/native.png', result: '' };
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (scenario === 'timeout') return;
  if (scenario === 'malformed') { process.stdout.write('invalid json\n'); return; }
  if (message.id === 1) {
    if (scenario === 'quota') send({ id: 1, error: { message: 'usage_limit_reached' } });
    else send({ id: 1, result: {} });
  }
  if (message.id === 2) send({ id: 2, result: scenario === 'missing-config' ? {}
    : { config: { mcp_servers: scenario === 'malformed-config' ? [] : { unneeded: {
      command: 'never-run-this', args: ['--credential', 'opaque-sensitive-value'], env: { CUSTOM_AUTH: 'opaque-sensitive-value' },
    } } } } });
  if (message.id === 3) {
    assert.ok(!['missing-config', 'malformed-config'].includes(scenario), 'must not start a thread with invalid config');
    assert.equal(message.params.config['mcp_servers.unneeded.enabled'], false);
    assert.equal(message.params.config['features.shell_tool'], false);
    assert.equal(message.params.config['features.apps'], false);
    assert.equal(message.params.ephemeral, true);
    assert.equal(message.params.approvalPolicy, 'never');
    assert.equal(message.params.sandbox, 'read-only');
    send({ id: 3, result: { thread: { id: threadId } } });
  }
  if (message.id === 4) {
    if (scenario === 'malformed-after-config') { process.stdout.write('invalid task protocol\n'); return; }
    assert.equal(message.params.input[0].text, 'untrusted test prompt');
    assert.deepEqual(message.params.input[1], { type: 'localImage', path: '/reference.png' });
    send({ id: 4, result: { turn: { id: turnId } } });
    send({ method: 'item/completed', params: { threadId: 'another-thread', turnId, item: { ...image, id: 'foreign' } } });
    send({ method: 'item/completed', params: { threadId, turnId: 'another-turn', item: { ...image, id: 'foreign-turn' } } });
    send({ method: 'error', params: { threadId, turnId, willRetry: true, error: { message: 'temporary reconnect' } } });
    if (scenario !== 'terminal-only') send({ method: 'item/completed', params: { threadId, turnId, item: image } });
    send({ method: 'item/completed', params: { threadId, turnId,
      item: { type: 'agentMessage', id: 'answer', text: '{"rawText":"Generated /forged/location.png"}' } } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: scenario === 'failed' ? 'failed' : 'completed',
      error: scenario === 'failed' ? { message: 'rate_limit_exceeded' } : null, items: [image] } } });
  }
});
