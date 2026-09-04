import assert from 'node:assert/strict';
import test from 'node:test';
import { imageExecutorLabel } from '../src/control-plane/image-executor-label.mjs';

test('image queue uses the actual image executor name, never the copy executor', () => {
  const task = { state: 'IMAGE_RUNNING', copyExecutorNodeId: 'copy-a',
    imageExecutorNodeId: 'image-b', imageExecutorNodeName: '生图工作站 B' };
  assert.equal(imageExecutorLabel(task), '生图工作站 B');
  assert.equal(imageExecutorLabel({ ...task, imageExecutorNodeName: null }), 'image-b');
  assert.equal(imageExecutorLabel({ state: 'IMAGE_RUNNING', copyExecutorNodeId: 'copy-a' }), '执行机信息不可用');
});

test('queued images including retries are not presented as claimed', () => {
  assert.equal(imageExecutorLabel({ state: 'IMAGE_QUEUED' }), '待领取');
  assert.equal(imageExecutorLabel({ state: 'IMAGE_QUEUED', imageExecutorNodeId: 'old-node',
    imageExecutorNodeName: '上次执行机' }), '待领取');
});
