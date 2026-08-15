import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { processNext } from '../src/pipeline.mjs';
import { createQueue } from '../src/queue.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const queue = createQueue(resolve(projectRoot, 'data', 'smoke.sqlite'));

try {
  const task = queue.enqueue({
    query: '租房卧室的桌面总是乱，怎么做低成本整理？',
    input: { platform: 'xiaohongshu', purpose: 'mock-smoke-test' },
  });
  const result = await processNext({
    queue,
    workerId: `smoke-${process.pid}`,
    outputRoot: resolve(projectRoot, 'output', 'smoke'),
    mock: true,
  });
  process.stdout.write(`${JSON.stringify({ enqueuedTaskId: task.id, ...result }, null, 2)}\n`);
  if (result.status !== 'completed') process.exitCode = 1;
} finally {
  queue.close();
}
