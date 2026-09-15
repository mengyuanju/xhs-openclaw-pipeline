import assert from 'node:assert/strict';
import test from 'node:test';

import {
  samplingRateBpsFromInput,
  samplingRateInputValue,
} from '../app/settings/sampling-rate-input.ts';

test('sampling rate input stays empty while editing before accepting a leading one', () => {
  assert.equal(samplingRateBpsFromInput(''), 0);
  assert.equal(samplingRateInputValue(0, ''), '');

  assert.equal(samplingRateBpsFromInput('1'), 100);
  assert.equal(samplingRateInputValue(100, '1'), '1');
  assert.equal(samplingRateInputValue(100, null), 1);
});

test('sampling rate input clamps and rounds values to basis points', () => {
  assert.equal(samplingRateBpsFromInput('-1'), 0);
  assert.equal(samplingRateBpsFromInput('12.345'), 1_235);
  assert.equal(samplingRateBpsFromInput('101'), 10_000);
  assert.equal(samplingRateBpsFromInput('not-a-number'), 0);
});
