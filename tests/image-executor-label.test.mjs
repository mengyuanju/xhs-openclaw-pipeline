import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
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

test('delivery review shows the successful executor name with safe missing-data fallbacks', () => {
  const task = { state: 'DELIVERY_REVIEW_PENDING', imageExecutorNodeId: 'image-b',
    imageExecutorNodeName: '成功生图机器 B' };
  assert.equal(imageExecutorLabel(task), '成功生图机器 B');
  assert.equal(imageExecutorLabel({ ...task, imageExecutorNodeName: null }), 'image-b');
  assert.equal(imageExecutorLabel({ state: 'DELIVERY_REVIEW_PENDING' }), '执行机信息不可用');
});

test('delivery review adds an image executor column without replacing the copy column', async () => {
  const source = await readFile(new URL('../app/workbench/creation-workbench.tsx', import.meta.url), 'utf8');
  assert.match(source, /activeView === 'DELIVERY_REVIEW' && <th>生图执行机<\/th>/u);
  assert.match(source, /activeView === 'DELIVERY_REVIEW' && <td[^>]*data-label="生图执行机">\{imageExecutorLabel\(task\)\}/u);
  assert.match(source, /<th>\{executorColumnLabel\}<\/th>/u);
});
