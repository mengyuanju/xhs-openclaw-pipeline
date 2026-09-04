import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectCopyExecutor } from '../src/control-plane/copy-executor-selection.mjs';

const node = (id, copyQueuedCount, copyRunningCount, online = true) => ({
  id, copyQueuedCount, copyRunningCount, online,
});

test('defaults to the lowest combined copy load among online executors', () => {
  const nodes = [
    node('first', 4, 1),
    node('offline', 0, 0, false),
    node('queued', 2, 0),
    { ...node('best', 0, 1), imageRunningCount: 10 },
  ];
  assert.equal(selectCopyExecutor(nodes)?.id, 'best');
  assert.equal(selectCopyExecutor([node('running', 0, 1), node('idle', 0, 0)])?.id, 'idle');
});

test('equal copy loads retain the supplied order without mutating the list', () => {
  const nodes = Object.freeze([node('first', 1, 0), node('second', 0, 1)]);
  assert.equal(selectCopyExecutor(nodes)?.id, 'first');
});

test('manual choices persist across load changes and fall back when unavailable', () => {
  const nodes = [node('idle', 0, 0), node('manual', 5, 1)];
  assert.equal(selectCopyExecutor(nodes, 'manual')?.id, 'manual');
  nodes[1].online = false;
  assert.equal(selectCopyExecutor(nodes, 'manual')?.id, 'idle');
  assert.equal(selectCopyExecutor(nodes, 'missing')?.id, 'idle');
  nodes[1].online = true;
  assert.equal(selectCopyExecutor(nodes, '')?.id, 'idle');
});

test('no online executors leaves the selection empty', () => {
  assert.equal(selectCopyExecutor([]), null);
  assert.equal(selectCopyExecutor([node('offline', 0, 0, false)], 'offline'), null);
});
