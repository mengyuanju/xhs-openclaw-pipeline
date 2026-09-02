import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  collectOpenClawCodexTrace,
  matchSessionsToPhases,
  redactSensitive,
  summarizeUsage,
  writeOpenClawCodexTrace,
} from '../src/openclaw-trace-export.mjs';

describe('OpenClaw to Codex trace export', () => {
  it('redacts credentials and PII without removing token usage counters', () => {
    const redacted = redactSensitive({
      authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
      access_token: 'top-secret-access-token',
      authProfileId: 'openai:operator@example.com',
      note: 'key=sk-example-secret-123456789 and operator@example.com',
      opaqueLog: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.abcdefghijklmnopqrstuv',
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
    assert.equal(redacted.opaqueLog, 'token [REDACTED_JWT]');
    assert.equal(redacted.path, '%USERPROFILE%\\.openclaw\\sessions\\xhs-1.jsonl');
    assert.deepEqual(redacted.usage, { input: 12, output: 3, totalTokens: 15 });
  });

  it('maps persisted OpenClaw sessions to the business phases that actually ran', () => {
    const phases = matchSessionsToPhases({
      generation: {
        query_review_json: '{"decision":"PASS","model":"gpt-test"}',
        original_post_json: '{"title":"original"}',
        reviewed_post_json: '{"title":"original"}',
        original_text_review_json: '{"decision":"PASS","stage":"original","model":"gpt-test"}',
        reviewed_text_review_json: '{"decision":"PASS","stage":"original","model":"gpt-test"}',
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

  it('collects a redacted business to OpenClaw to Codex trace bundle', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'xhs-trace-export-'));
    try {
      const databasePath = join(fixtureRoot, 'queue.db');
      const openClawRoot = join(fixtureRoot, '.openclaw');
      const sessionRoot = join(openClawRoot, 'agents', 'main', 'sessions');
      const codexHome = join(openClawRoot, 'agents', 'main', 'agent', 'codex-home');
      const rolloutPath = join(codexHome, 'sessions', 'rollout.jsonl');
      mkdirSync(sessionRoot, { recursive: true });
      mkdirSync(join(openClawRoot, 'state'), { recursive: true });
      mkdirSync(join(codexHome, 'sessions'), { recursive: true });

      const business = new DatabaseSync(databasePath);
      business.exec(`
        CREATE TABLE standalone_copy_generation_jobs (
          id INTEGER PRIMARY KEY, query TEXT NOT NULL, status TEXT NOT NULL,
          generation_id INTEGER, error TEXT, created_at TEXT NOT NULL, finished_at TEXT
        ) STRICT;
        CREATE TABLE standalone_copy_generations (
          id INTEGER PRIMARY KEY, query TEXT NOT NULL, input_json TEXT NOT NULL,
          requested_image_count TEXT NOT NULL, original_post_json TEXT NOT NULL,
          reviewed_post_json TEXT NOT NULL, original_model TEXT NOT NULL,
          reviewed_model TEXT NOT NULL, query_review_json TEXT NOT NULL,
          original_text_review_json TEXT NOT NULL, reviewed_text_review_json TEXT NOT NULL,
          research_snapshot_json TEXT, created_at TEXT NOT NULL,
          query_review_ms INTEGER, research_ms INTEGER, original_generation_ms INTEGER,
          original_review_ms INTEGER, reviewed_generation_ms INTEGER,
          reviewed_review_ms INTEGER, total_ms INTEGER,
          original_thinking TEXT, reviewed_thinking TEXT
        ) STRICT;
      `);
      business.prepare(`
        INSERT INTO standalone_copy_generation_jobs
          (id, query, status, generation_id, created_at, finished_at)
        VALUES (?, ?, 'COMPLETED', ?, ?, ?)
      `).run(7, '测试 Query', 9, '2026-09-02T02:00:00.000Z', '2026-09-02T02:01:00.000Z');
      business.prepare(`
        INSERT INTO standalone_copy_generations VALUES
          (?, ?, '{}', 'auto', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        9,
        '测试 Query',
        '{"title":"原稿"}',
        '{"title":"原稿"}',
        'openai/gpt-test',
        'openai/gpt-test',
        '{"decision":"PASS"}',
        '{"decision":"PASS","stage":"original"}',
        '{"decision":"PASS","stage":"original"}',
        '{"provider":"duckduckgo","sources":[{"url":"https://example.com"}]}',
        '2026-09-02T02:01:00.000Z',
        10, 20, 30, 0, 0, 0, 60, 'low', 'low',
      );
      business.close();

      const sessionId = 'xhs-11111111-1111-4111-8111-111111111111';
      writeFileSync(join(sessionRoot, `${sessionId}.jsonl`), [
        { type: 'session', id: sessionId, timestamp: '2026-09-02T02:00:01.000Z', cwd: 'C:\\Users\\operator\\workspace' },
        { type: 'message', id: 'user-1', timestamp: '2026-09-02T02:00:01.000Z', message: { role: 'user', content: 'operator@example.com asks for review' } },
        { type: 'message', id: 'assistant-1', timestamp: '2026-09-02T02:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '{"decision":"PASS"}' }], provider: 'openai', model: 'gpt-test', usage: { input: 4, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 9 } } },
      ].map((row) => JSON.stringify(row)).join('\n'));
      writeFileSync(join(sessionRoot, `${sessionId}.trajectory.jsonl`), [
        { type: 'session.started', ts: '2026-09-02T02:00:01.000Z', sessionId, runId: 'run-1', provider: 'openai', modelId: 'gpt-test', data: { threadId: 'thread-1', authProfileId: 'openai:operator@example.com' } },
        { type: 'model.completed', ts: '2026-09-02T02:00:02.000Z', sessionId, runId: 'run-1', data: { threadId: 'thread-1', turnId: 'turn-1', usage: { totalTokens: 9 } } },
      ].map((row) => JSON.stringify(row)).join('\n'));
      writeFileSync(rolloutPath, `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 9 } } } })}\n`);

      const codexState = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
      codexState.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, tokens_used INTEGER, reasoning_effort TEXT) STRICT;');
      codexState.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run('thread-1', rolloutPath, 9, 'low');
      codexState.close();
      const codexLogs = new DatabaseSync(join(codexHome, 'logs_2.sqlite'));
      codexLogs.exec(`
        CREATE TABLE logs (
          id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, level TEXT, target TEXT,
          feedback_log_body TEXT, module_path TEXT, file TEXT, line INTEGER,
          thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER
        ) STRICT;
      `);
      codexLogs.prepare(`
        INSERT INTO logs (id, ts, level, target, feedback_log_body, thread_id)
        VALUES (1, 1, 'INFO', 'codex', ?, 'thread-1')
      `).run('operator@example.com Bearer abcdefghijklmnopqrstuvwxyz');
      codexLogs.close();

      const openClawState = new DatabaseSync(join(openClawRoot, 'state', 'openclaw.sqlite'));
      openClawState.exec(`
        CREATE TABLE audit_events (
          sequence INTEGER, event_id TEXT, source_id TEXT, source_sequence INTEGER,
          occurred_at INTEGER, kind TEXT, action TEXT, status TEXT, error_code TEXT,
          actor_type TEXT, actor_id TEXT, agent_id TEXT, session_key TEXT,
          session_id TEXT, run_id TEXT, tool_call_id TEXT, tool_name TEXT
        ) STRICT;
      `);
      openClawState.prepare(`
        INSERT INTO audit_events (sequence, event_id, occurred_at, kind, action, status, session_id, run_id)
        VALUES (1, 'event-1', ?, 'model', 'complete', 'ok', ?, 'run-1')
      `).run(Date.parse('2026-09-02T02:00:02.000Z'), sessionId);
      openClawState.close();

      const report = collectOpenClawCodexTrace({
        databasePath,
        openClawRoot,
        jobId: 7,
        capturedAt: '2026-09-02T03:00:00.000Z',
        userProfile: 'C:\\Users\\operator',
      });

      assert.equal(report.business.job.id, 7);
      assert.equal(report.chain.phases[0].sessionId, sessionId);
      assert.equal(report.chain.usage.totalTokens, 9);
      assert.equal(report.openclaw.sessions[0].records[1].message.content, '[REDACTED_EMAIL] asks for review');
      assert.equal(report.openclaw.sessions[0].trajectory[0].data.authProfileId, 'openai:[REDACTED_EMAIL]');
      assert.equal(report.openclaw.auditEvents.length, 1);
      assert.equal(report.codex.threads[0].records[0].payload.info.total_token_usage.total_tokens, 9);
      assert.equal(report.codex.threads[0].logs[0].feedback_log_body, '[REDACTED_EMAIL] Bearer [REDACTED_TOKEN]');
      assert.equal(report.coverage.openclaw.sessionMessages, false);
      assert.equal(report.coverage.openclaw.trajectories, false);
      assert.equal(report.coverage.codex.rollouts, false);
      assert.equal(report.coverage.research.rawCapabilityEnvelope, false);

      const output = writeOpenClawCodexTrace({ report, outputRoot: join(fixtureRoot, 'exports') });
      assert.equal(JSON.parse(readFileSync(output.jsonPath, 'utf8')).business.job.id, 7);
      assert.match(readFileSync(output.summaryPath, 'utf8'), /job #7/u);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
