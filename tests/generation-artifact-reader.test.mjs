import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { attachGenerationVisualPlans } from '../src/admin/generation-artifact-reader.mjs';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('hydrates historical generation runs from their bounded visual-plan artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-generation-artifacts-'));
  directories.push(root);
  const outputDir = join(root, '7', 'attempt-2');
  await mkdir(outputDir, { recursive: true });
  const visualPlan = {
    schemaVersion: 1,
    pages: [{ pageIndex: 1, layoutDirection: '左图右文。' }],
  };
  await writeFile(join(outputDir, 'visual-plan.json'), JSON.stringify(visualPlan));

  const task = await attachGenerationVisualPlans({
    id: 7,
    generationRuns: [{ id: 11, attempt: 2, outputDir, visualPlan: null }],
  }, { outputRoot: root });

  assert.deepEqual(task.generationRuns[0].visualPlan, visualPlan);
});

test('keeps persisted plans and ignores artifacts outside the matching task attempt directory', async () => {
  const persistedPlan = { schemaVersion: 1, pages: [{ pageIndex: 1 }] };
  const task = await attachGenerationVisualPlans({
    id: 7,
    generationRuns: [
      { id: 11, attempt: 2, outputDir: 'relative/7/attempt-2', visualPlan: null },
      { id: 12, attempt: 3, outputDir: 'relative/7/attempt-3', visualPlan: persistedPlan },
    ],
  }, { outputRoot: join(process.cwd(), 'output') });

  assert.equal(task.generationRuns[0].visualPlan, null);
  assert.equal(task.generationRuns[1].visualPlan, persistedPlan);
});
