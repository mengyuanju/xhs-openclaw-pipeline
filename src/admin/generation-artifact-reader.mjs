import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const MAX_VISUAL_PLAN_BYTES = 250_000;

function expectedAttemptDirectory(outputRoot, taskId, run) {
  if (!isAbsolute(outputRoot ?? '') || !Number.isInteger(taskId)
    || !Number.isInteger(run?.attempt) || !isAbsolute(run?.outputDir ?? '')) {
    return null;
  }
  const outputDir = resolve(run.outputDir);
  const expected = resolve(outputRoot, String(taskId), `attempt-${run.attempt}`);
  return outputDir === expected ? outputDir : null;
}

async function readVisualPlan(outputRoot, taskId, run) {
  const outputDir = expectedAttemptDirectory(outputRoot, taskId, run);
  if (!outputDir) return null;
  const artifactPath = join(outputDir, 'visual-plan.json');
  try {
    const metadata = await stat(artifactPath);
    if (!metadata.isFile() || metadata.size > MAX_VISUAL_PLAN_BYTES) return null;
    const content = await readFile(artifactPath, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_VISUAL_PLAN_BYTES) return null;
    const visualPlan = JSON.parse(content);
    return visualPlan && typeof visualPlan === 'object' && !Array.isArray(visualPlan)
      && Array.isArray(visualPlan.pages)
      ? visualPlan
      : null;
  } catch {
    return null;
  }
}

export async function attachGenerationVisualPlans(task, { outputRoot } = {}) {
  if (!task || !Array.isArray(task.generationRuns)) return task;
  const generationRuns = await Promise.all(task.generationRuns.map(async (run) => {
    if (run.visualPlan) return run;
    return { ...run, visualPlan: await readVisualPlan(outputRoot, task.id, run) };
  }));
  return { ...task, generationRuns };
}
