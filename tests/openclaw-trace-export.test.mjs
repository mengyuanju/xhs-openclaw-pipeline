import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  matchSessionsToPhases,
  redactSensitive,
  summarizeUsage,
} from '../src/openclaw-trace-export.mjs';

describe('OpenClaw to Codex trace export', () => {
  it('redacts credentials and PII without removing token usage counters', () => {
    const redacted = redactSensitive({
      authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
      access_token: 'top-secret-access-token',
      authProfileId: 'openai:operator@example.com',
      note: 'key=sk-example-secret-123456789 and operator@example.com',
      path: 'C:\\Users\\operator\\.openclaw\\sessions\\xhs-1.jsonl',
      usage: {
        input: 12,
        output: 3,
        totalTokens: 15,
      },
    }, { userProfile: 'C:\\Users\\operator' });

    assert.equal(redacted.authorization, '[REDACTED]');
    assert.equal(redacted.access_token, '[REDACTED]');
    assert.equal(redacted.authProfileId, 'openai:[REDACTED_EMAIL]');
    assert.equal(redacted.note, 'key=[REDACTED_API_KEY] and [REDACTED_EMAIL]');
    assert.equal(redacted.path, '%USERPROFILE%\\.openclaw\\sessions\\xhs-1.jsonl');
    assert.deepEqual(redacted.usage, { input: 12, output: 3, totalTokens: 15 });
  });

  it('maps persisted OpenClaw sessions to the business phases that actually ran', () => {
    const phases = matchSessionsToPhases({
      generation: {
        query_review_json: '{"decision":"PASS"}',
        original_post_json: '{"title":"original"}',
        reviewed_post_json: '{"title":"original"}',
        original_text_review_json: '{"decision":"PASS","stage":"original"}',
        reviewed_text_review_json: '{"decision":"PASS","stage":"original"}',
        query_review_ms: 10,
        research_ms: 40,
        original_generation_ms: 20,
        original_review_ms: 30,
        reviewed_generation_ms: 0,
        reviewed_review_ms: 0,
      },
      sessions: [
        { sessionId: 'xhs-query', assistantText: '{ "decision": "PASS" }' },
        { sessionId: 'xhs-generate', assistantText: '{"title":"original"}' },
        { sessionId: 'xhs-review', assistantText: '{"decision":"PASS","stage":"original"}' },
      ],
    });

    assert.deepEqual(phases.map(({ phase, durationMs, sessionId, persistedAt }) => ({
      phase,
      durationMs,
      sessionId,
      persistedAt,
    })), [
      { phase: 'query_review', durationMs: 10, sessionId: 'xhs-query', persistedAt: 'openclaw_session' },
      { phase: 'research', durationMs: 40, sessionId: null, persistedAt: 'business_snapshot_only' },
      { phase: 'original_generation', durationMs: 20, sessionId: 'xhs-generate', persistedAt: 'openclaw_session' },
      { phase: 'original_review', durationMs: 30, sessionId: 'xhs-review', persistedAt: 'openclaw_session' },
    ]);
  });

  it('sums OpenClaw token usage across all matched Codex sessions', () => {
    assert.deepEqual(summarizeUsage([
      { usage: { input: 11, output: 5, cacheRead: 7, cacheWrite: 2, totalTokens: 25 } },
      { usage: { input: 13, output: 3, cacheRead: 17, cacheWrite: 0, totalTokens: 33 } },
      { usage: null },
    ]), {
      sessions: 2,
      input: 24,
      output: 8,
      cacheRead: 24,
      cacheWrite: 2,
      totalTokens: 58,
    });
  });
});
