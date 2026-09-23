import test from 'node:test';
import assert from 'node:assert/strict';
import { plannedSampleCount, rejectionTriggerCount } from '../src/copy-qa-v2.mjs';

test('personal automatic batches sample the chosen members with ceiling rounding',()=>{
  assert.equal(plannedSampleCount(0,5000),0);
  assert.equal(plannedSampleCount(1,0),0);
  assert.equal(plannedSampleCount(3,2000),1);
  assert.equal(plannedSampleCount(10,2000),2);
  assert.equal(plannedSampleCount(3,10000),3);
});

test('rejection threshold is based on original sampled count',()=>{
  assert.equal(rejectionTriggerCount(0,5000),0);
  assert.equal(rejectionTriggerCount(1,5000),1);
  assert.equal(rejectionTriggerCount(3,5000),2);
  assert.equal(rejectionTriggerCount(4,7500),3);
  assert.equal(rejectionTriggerCount(4,10000),4);
});
