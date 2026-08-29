import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyTaskFailure,
  planTaskRecovery,
} from '../src/task-recovery.mjs';

describe('task failure recovery policy', () => {
  it('classifies auth failures before generic transport or model failures', () => {
    assert.equal(classifyTaskFailure(new Error('401 token_invalidated during fetch failed')), 'AUTH');
    assert.equal(classifyTaskFailure(new Error('OAuth token expired; login required')), 'AUTH');
  });

  it('classifies transient, quality, structure and configuration failures', () => {
    assert.equal(classifyTaskFailure(new Error('fetch failed: UND_ERR_SOCKET')), 'TRANSIENT');
    assert.equal(classifyTaskFailure(new Error('server_is_overloaded: temporarily unavailable')), 'TRANSIENT');
    assert.equal(classifyTaskFailure(new Error('质量门禁未通过：图片多样性不足')), 'QUALITY');
    assert.equal(classifyTaskFailure(new Error('正文输出未通过结构校验：invalid JSON')), 'STRUCTURE');
    assert.equal(classifyTaskFailure(new Error('Unknown model: invalid/model')), 'CONFIGURATION');
  });

  it('uses bounded backoff and stops after the per-class or overall limit', () => {
    const first = planTaskRecovery({
      error: new Error('fetch failed: ECONNRESET'),
      recoveryAttempts: 0,
      recoveryTotalAttempts: 0,
    });
    const second = planTaskRecovery({
      error: new Error('fetch failed: ECONNRESET'),
      recoveryAttempts: 1,
      recoveryTotalAttempts: 1,
    });
    const exhausted = planTaskRecovery({
      error: new Error('fetch failed: ECONNRESET'),
      recoveryAttempts: 2,
      recoveryTotalAttempts: 2,
    });
    const overallExhausted = planTaskRecovery({
      error: new Error('质量门禁未通过'),
      recoveryAttempts: 0,
      recoveryTotalAttempts: 4,
    });

    assert.deepEqual(first, {
      failureClass: 'TRANSIENT',
      action: 'RETRY',
      delayMs: 15_000,
      manualRequired: false,
      haltWorker: false,
      reason: 'transient_failure',
    });
    assert.equal(second.delayMs, 60_000);
    assert.equal(exhausted.action, 'MANUAL');
    assert.equal(exhausted.reason, 'class_retry_limit_reached');
    assert.equal(overallExhausted.action, 'MANUAL');
    assert.equal(overallExhausted.reason, 'overall_retry_limit_reached');
  });

  it('retries quality and structure failures once but never retries auth or configuration', () => {
    const quality = planTaskRecovery({
      error: new Error('质量门禁未通过'),
      recoveryAttempts: 0,
      recoveryTotalAttempts: 0,
    });
    const structure = planTaskRecovery({
      error: new Error('visual plan returned an invalid result'),
      recoveryAttempts: 0,
      recoveryTotalAttempts: 0,
    });
    const auth = planTaskRecovery({
      error: new Error('401 token_invalidated'),
      recoveryAttempts: 0,
      recoveryTotalAttempts: 0,
    });
    const configuration = planTaskRecovery({
      error: new Error('Unknown model: invalid/model'),
      recoveryAttempts: 0,
      recoveryTotalAttempts: 0,
    });

    assert.equal(quality.action, 'RETRY');
    assert.equal(quality.delayMs, 0);
    assert.equal(structure.action, 'RETRY');
    assert.equal(structure.delayMs, 5_000);
    assert.equal(auth.action, 'MANUAL');
    assert.equal(auth.haltWorker, true);
    assert.equal(configuration.action, 'MANUAL');
    assert.equal(configuration.haltWorker, false);
  });
});
