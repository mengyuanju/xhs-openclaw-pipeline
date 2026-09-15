import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compareTasks } from '../app/workbench/views.ts';

test('personal queue compares priority, FIFO and waiting compensation consistently with server', () => {
  const task = (id, priority, entered, paused = false) => ({ id, state: 'COPY_REVIEW_PENDING',
    createdAt: entered, queueEnteredAt: entered, effectivePriority: priority, priorityPaused: paused });
  const now = '2026-09-14T12:00:00Z';
  const rows = [task(1,100,now),task(2,300,now),task(3,400,now),task(4,500,now,true),task(5,100,'2026-09-09T12:00:00Z')];
  assert.deepEqual(rows.sort((a,b) => compareTasks(a,b,'priority:desc')).map(row => row.id), [5,3,2,1,4]);
  assert.ok(compareTasks(task(9,300,'2026-09-14T11:00:00Z'),task(1,300,now),'priority:desc') < 0);
});

test('list, details and batch controls show priority sources and submit reviewed scopes with versions', async () => {
  const [control,list,detail,styles] = await Promise.all(['app/workbench/task-priority-control.tsx',
    'app/workbench/creation-workbench.tsx','app/workbench/task-review-dialog.tsx',
    'app/workbench/task-priority-control.module.css'].map(path => readFile(path,'utf8')));
  for (const mode of ['SYSTEM','HIGHEST','HIGH','NORMAL','DEFER','PAUSE']) assert.ok(control.includes(`'${mode}'`));
  assert.match(control, /expectedVersions: Object\.fromEntries/u);
  assert.match(control, /productionBatchId: batchId/u);
  assert.match(control, /disabled=\{busy \|\| !reason\.trim\(\)\}/u);
  assert.match(control, /setPreview\(null\)/u);
  assert.match(list, /TaskPriorityControl tasks=\{selectedTasks\}/u);
  assert.match(list, /role === 'ADMIN' && <TaskPriorityControl/u);
  assert.match(detail, /role === 'ADMIN' && <TaskPriorityControl/u);
  assert.match(list, /search\.set\('priorityMode', priorityMode\)/u);
  assert.match(control, /系统 \$\{task\.systemPriority/u);
  assert.match(control, /DialogContent className=\{styles\.dialog\}/u);
  assert.match(styles, /background: var\(--surface\)/u);
  assert.match(styles, /max-height: calc\(100dvh - 32px\)/u);
});
