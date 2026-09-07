import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { codexFailure, parseCodexOutput } from '../src/codex-protocol.mjs';
import { classifyTaskFailure, planTaskRecovery } from '../src/task-recovery.mjs';
import { matchCopyKnowledge } from '../src/copy-knowledge-match.mjs';

const CAPACITY_MESSAGE = 'Selected model is at capacity. Please try a different model.';
const TLS_MESSAGE = 'stream disconnected before completion: IO error: peer closed connection without sending TLS close_notify';
const lines = (...events) => events.map(JSON.stringify).join('\n');

describe('remote runtime failure categories', () => {
  it('classifies provider capacity separately from account quota without halting the worker', () => {
    const error = codexFailure({ type: 'error', message: CAPACITY_MESSAGE });

    assert.equal(error.code, 'CODEX_MODEL_AT_CAPACITY');
    assert.equal(error.haltWorker, false);
    assert.match(error.message, /Selected model is at capacity/u);
    assert.doesNotMatch(error.message, /额度不足|quota_exhausted/iu);
  });

  it('retains terminal TLS diagnostics under a transport-specific code', () => {
    assert.throws(() => parseCodexOutput(lines({ type: 'turn.failed', error: { message: TLS_MESSAGE } })),
      (error) => error.code === 'CODEX_TRANSPORT_FAILED'
        && error.message.includes('TLS close_notify') && error.haltWorker === false);
  });

  it('retains an existing timeout code and outcome uncertainty when normalizing diagnostics', () => {
    const error = codexFailure({ code: 'CODEX_EXEC_TIMEOUT', message: 'text call timed out; outcome may be unknown' });

    assert.equal(error.code, 'CODEX_EXEC_TIMEOUT');
    assert.match(error.message, /timed out; outcome may be unknown/u);
    assert.equal(error.haltWorker, false);
  });

  it('allows a fresh completed answer after a TLS reconnect notice', () => {
    const parsed = parseCodexOutput(lines(
      { type: 'error', message: `Reconnecting... 2/5 (${TLS_MESSAGE})` },
      { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'fresh final answer' } },
      { type: 'turn.completed' },
    ));

    assert.equal(parsed.rawText, 'fresh final answer');
    assert.equal(parsed.reconnectCount, 1);
  });

  it('classifies a wrapped typed capacity failure as transient without claiming quota exhaustion', () => {
    const cause = Object.assign(new Error(CAPACITY_MESSAGE), { code: 'CODEX_MODEL_AT_CAPACITY' });
    const error = new Error('图片验收失败', { cause });

    assert.equal(classifyTaskFailure(error), 'TRANSIENT');
    const recovery = planTaskRecovery({ error });
    assert.equal(recovery.failureClass, 'TRANSIENT');
    assert.equal(recovery.haltWorker, false);
    assert.notEqual(recovery.reason, 'quota_exhausted');
  });

  for (const code of ['CODEX_EXEC_TIMEOUT', 'CODEX_TRANSPORT_FAILED']) {
    it(`keeps ${code} manual because the remote outcome may be unknown`, () => {
      const cause = Object.assign(new Error('timed out / stream disconnected; outcome may be unknown'), { code });
      const recovery = planTaskRecovery({ error: new Error('图片生成失败', { cause }) });

      assert.equal(recovery.action, 'MANUAL');
      assert.equal(recovery.manualRequired, true);
      assert.equal(recovery.delayMs, null);
      assert.equal(recovery.haltWorker, false);
    });
  }

  for (const [code, message] of [
    ['CODEX_QUOTA_EXHAUSTED', 'usage_limit_reached'],
    ['CODEX_AUTH_REQUIRED', 'login required'],
  ]) {
    it(`never retries ${code} automatically`, () => {
      const recovery = planTaskRecovery({ error: codexFailure({ message }) });

      assert.equal(recovery.action, 'MANUAL');
      assert.equal(recovery.haltWorker, true);
    });
  }
});

describe('knowledge matching preserves runtime failure evidence', () => {
  for (const [code, message] of [
    ['CODEX_MODEL_AT_CAPACITY', CAPACITY_MESSAGE],
    ['CODEX_TRANSPORT_FAILED', TLS_MESSAGE],
    ['CODEX_EXEC_TIMEOUT', 'text call timed out; outcome may be unknown'],
    ['CODEX_QUOTA_EXHAUSTED', 'usage_limit_reached'],
    ['CODEX_AUTH_REQUIRED', 'login required'],
    ['CODEX_RATE_LIMITED', 'rate limit exceeded; shared cooldown active'],
  ]) {
    it(`propagates ${code} after one model call without a scoring-format retry`, async () => {
      const original = Object.assign(new Error(message), {
        code,
        haltWorker: ['CODEX_QUOTA_EXHAUSTED', 'CODEX_AUTH_REQUIRED'].includes(code),
      });
      let calls = 0;
      let failure;
      try {
        await matchCopyKnowledge({
          query: '复现案例匹配运行时故障',
          knowledge: [
            { itemId: 1, versionId: 101, kind: 'COPY', content: { summary: '完整案例摘要', analysis: '完整案例分析' } },
          ],
          client: { async runText() { calls++; throw original; } },
        });
      } catch (error) {
        failure = error;
      }

      assert.equal(calls, 1, 'runtime failures must not immediately repeat the same model request');
      assert.ok(failure, 'a runtime failure must block matching');
      assert.equal(failure.code, code);
      assert.ok(failure.message.includes(message), 'the actionable provider diagnostic must remain visible');
      assert.doesNotMatch(failure.message, /未获得完整有效的评分/u);
      assert.equal(failure.haltWorker, original.haltWorker);
    });
  }
});
