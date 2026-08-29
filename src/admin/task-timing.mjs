const MAX_SAMPLE_DURATION_MS = 24 * 60 * 60_000;
const MAX_SAMPLES = 30;

function timestampMs(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function durationMs(start, end) {
  const startMs = timestampMs(start);
  const endMs = timestampMs(end);
  if (startMs === null || endMs === null || endMs < startMs) return null;
  return endMs - startMs;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function validImageCount(value) {
  const imageCount = Number(value);
  return Number.isInteger(imageCount) && imageCount >= 3 && imageCount <= 5
    ? imageCount
    : 3;
}

export function summarizeTaskDurations(samples) {
  const validSamples = samples
    .map((sample) => ({
      durationMs: Number(sample.durationMs),
      imageCount: validImageCount(sample.imageCount),
    }))
    .filter((sample) => Number.isFinite(sample.durationMs)
      && sample.durationMs >= 1_000
      && sample.durationMs <= MAX_SAMPLE_DURATION_MS)
    .slice(0, MAX_SAMPLES);
  const byImageCount = {};
  for (const imageCount of [3, 4, 5]) {
    const durations = validSamples
      .filter((sample) => sample.imageCount === imageCount)
      .map((sample) => sample.durationMs);
    if (durations.length > 0) {
      byImageCount[imageCount] = {
        sampleSize: durations.length,
        typicalDurationMs: median(durations),
      };
    }
  }
  return {
    sampleSize: validSamples.length,
    typicalDurationMs: median(validSamples.map((sample) => sample.durationMs)),
    byImageCount,
  };
}

function estimateForImageCount(stats, imageCount) {
  const specific = stats?.byImageCount?.[validImageCount(imageCount)];
  if (specific?.typicalDurationMs) return { ...specific, scope: 'same_image_count' };
  if (!stats?.typicalDurationMs) return null;
  return {
    sampleSize: Number(stats.sampleSize) || 0,
    typicalDurationMs: Number(stats.typicalDurationMs),
    scope: 'all',
  };
}

function activeQueueDelay(stats, nowMs) {
  if (!Array.isArray(stats?.activeTasks) || stats.activeTasks.length === 0) return 0;
  const remaining = stats.activeTasks.flatMap((task) => {
    const startedAt = timestampMs(task.processingStartedAt);
    const estimate = estimateForImageCount(stats, task.imageCount)?.typicalDurationMs;
    if (startedAt === null || !estimate) return [];
    return [Math.max(0, estimate - (nowMs - startedAt))];
  });
  return remaining.length > 0 ? Math.min(...remaining) : null;
}

export function buildTaskTiming(task, stats, { now = new Date() } = {}) {
  const nowMs = timestampMs(now) ?? Date.now();
  const actualDurationMs = durationMs(task.processingStartedAt, task.finishedAt);
  const base = {
    actualDurationMs,
    elapsedMs: null,
    estimatedDurationMs: null,
    estimatedRemainingMs: null,
    estimatedCompletionAt: null,
    estimateSampleSize: 0,
    estimateScope: null,
    queuePosition: Number.isInteger(task.queuePosition) ? task.queuePosition : null,
  };
  if (task.status === 'completed' || task.status === 'failed') return base;

  const estimate = estimateForImageCount(stats, task.config?.imageCount);
  if (task.status === 'processing') {
    const startedAt = timestampMs(task.processingStartedAt);
    const elapsedMs = startedAt === null ? null : Math.max(0, nowMs - startedAt);
    if (!estimate || elapsedMs === null) return { ...base, elapsedMs };
    const estimatedRemainingMs = Math.max(0, estimate.typicalDurationMs - elapsedMs);
    return {
      ...base,
      elapsedMs,
      estimatedDurationMs: estimate.typicalDurationMs,
      estimatedRemainingMs,
      estimatedCompletionAt: estimatedRemainingMs > 0
        ? new Date(nowMs + estimatedRemainingMs).toISOString()
        : null,
      estimateSampleSize: estimate.sampleSize,
      estimateScope: estimate.scope,
    };
  }

  if (task.status === 'pending' && estimate && base.queuePosition !== null) {
    const queueDelay = activeQueueDelay(stats, nowMs);
    if (queueDelay === null) return base;
    const estimatedRemainingMs = queueDelay + base.queuePosition * estimate.typicalDurationMs;
    return {
      ...base,
      estimatedDurationMs: estimate.typicalDurationMs,
      estimatedRemainingMs,
      estimatedCompletionAt: new Date(nowMs + estimatedRemainingMs).toISOString(),
      estimateSampleSize: estimate.sampleSize,
      estimateScope: estimate.scope,
    };
  }
  return base;
}

export function readTaskTimingStats(db, { now = new Date() } = {}) {
  const sampleRows = db.prepare(`
    SELECT t.processing_started_at, t.finished_at, tc.image_count
    FROM tasks t
    LEFT JOIN task_configs tc ON tc.task_id = t.id
    WHERE t.status = 'completed'
      AND t.processing_started_at IS NOT NULL
      AND t.finished_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM generation_runs gr
        WHERE gr.task_id = t.id AND gr.attempt = t.attempts
          AND gr.mode = 'live' AND gr.status = 'COMPLETED'
      )
    ORDER BY t.finished_at DESC
    LIMIT ?
  `).all(MAX_SAMPLES);
  const summary = summarizeTaskDurations(sampleRows.map((row) => ({
    durationMs: durationMs(row.processing_started_at, row.finished_at),
    imageCount: row.image_count,
  })));
  const activeTasks = db.prepare(`
    SELECT t.processing_started_at, tc.image_count
    FROM tasks t
    LEFT JOIN task_configs tc ON tc.task_id = t.id
    WHERE t.status = 'processing'
    ORDER BY t.id
  `).all().map((row) => ({
    processingStartedAt: row.processing_started_at,
    imageCount: validImageCount(row.image_count),
  }));
  const serverNow = now instanceof Date ? now : new Date(now);
  return {
    ...summary,
    activeTasks,
    serverNow: (Number.isNaN(serverNow.getTime()) ? new Date() : serverNow).toISOString(),
  };
}
