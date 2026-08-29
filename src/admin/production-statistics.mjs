function timestamp(value) {
  const milliseconds = Date.parse(value ?? '');
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function scoreCounts() {
  return { 0: 0, 1: 0, 2: 0, 3: 0 };
}

function validScore(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 3 ? number : null;
}

function latestRunsByTask(runs) {
  const latest = new Map();
  for (const run of runs) {
    const taskId = Number(run.taskId);
    const current = latest.get(taskId);
    if (!current || Number(run.id ?? run.attempt ?? 0) >= Number(current.id ?? current.attempt ?? 0)) {
      latest.set(taskId, run);
    }
  }
  return latest;
}

export function summarizeImportBatchStatistics({ batch, tasks = [], runs = [], now = new Date() }) {
  const statusCounts = { pending: 0, processing: 0, completed: 0, failed: 0 };
  for (const task of tasks) {
    if (Object.hasOwn(statusCounts, task.status)) statusCounts[task.status] += 1;
  }
  const taskCount = tasks.length;
  const finishedTaskCount = statusCounts.completed + statusCounts.failed;
  const latestRuns = latestRunsByTask(runs);
  const initialScoreCounts = scoreCounts();
  const finalScoreCounts = scoreCounts();
  let qualityRepairAttempts = 0;
  let qualityRepairRuns = 0;
  let qualityRepairTargetReached = 0;

  for (const run of runs) {
    const repair = run?.qcDetail?.qualityRepair;
    const attempts = Array.isArray(repair?.attempts) ? repair.attempts.length : 0;
    qualityRepairAttempts += attempts;
    if (attempts > 0) qualityRepairRuns += 1;
    const repairTarget = validScore(repair?.targetScore) ?? 2;
    if (attempts > 0 && validScore(repair.finalScore) >= repairTarget) qualityRepairTargetReached += 1;
  }
  for (const run of latestRuns.values()) {
    const finalScore = validScore(run.qcScore ?? run?.qcDetail?.overallScore);
    if (finalScore !== null) finalScoreCounts[finalScore] += 1;
    const initialScore = validScore(run?.qcDetail?.qualityRepair?.initialScore ?? finalScore);
    if (initialScore !== null) initialScoreCounts[initialScore] += 1;
  }

  const validDurations = runs.map((run) => Number(run.durationMs))
    .filter((duration) => Number.isFinite(duration) && duration >= 0);
  const startTimes = runs.map((run) => timestamp(run.startedAt)).filter((value) => value !== null);
  const finishTimes = runs.map((run) => timestamp(run.finishedAt)).filter((value) => value !== null);
  const startedMs = startTimes.length > 0 ? Math.min(...startTimes) : null;
  const allTasksFinished = taskCount > 0 && finishedTaskCount === taskCount;
  const finishedMs = allTasksFinished && finishTimes.length > 0 ? Math.max(...finishTimes) : null;
  const nowMs = timestamp(now instanceof Date ? now.toISOString() : now) ?? Date.now();
  const wallEndMs = finishedMs ?? (startedMs === null ? null : nowMs);

  return {
    batchId: Number(batch?.id),
    taskCount,
    finishedTaskCount,
    progressPercent: taskCount === 0 ? 0 : Math.round((finishedTaskCount / taskCount) * 100),
    statusCounts,
    runCount: runs.length,
    committedAt: batch?.committedAt ?? null,
    startedAt: startedMs === null ? null : new Date(startedMs).toISOString(),
    finishedAt: finishedMs === null ? null : new Date(finishedMs).toISOString(),
    wallDurationMs: startedMs === null || wallEndMs === null ? null : Math.max(0, wallEndMs - startedMs),
    averageRunDurationMs: validDurations.length === 0
      ? null
      : Math.round(validDurations.reduce((sum, duration) => sum + duration, 0) / validDurations.length),
    initialScoreCounts,
    finalScoreCounts,
    qualityRepairAttempts,
    qualityRepairRuns,
    qualityRepairTargetReached,
  };
}

function parseQcDetail(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rowToStatisticsRun(run) {
  return {
    id: Number(run.id),
    taskId: Number(run.task_id),
    attempt: Number(run.attempt),
    qcScore: run.qc_score === null ? null : Number(run.qc_score),
    qcDetail: parseQcDetail(run.qc_detail_json),
    startedAt: run.started_at ?? null,
    finishedAt: run.finished_at ?? null,
    durationMs: run.duration_ms === null ? null : Number(run.duration_ms),
  };
}

function groupedStatisticsRows(db) {
  const tasksByBatch = new Map();
  for (const row of db.prepare(`
    SELECT tc.import_batch_id, t.id, t.status
    FROM task_configs tc JOIN tasks t ON t.id = tc.task_id
    WHERE tc.import_batch_id IS NOT NULL
    ORDER BY t.id
  `).all()) {
    const batchId = Number(row.import_batch_id);
    if (!tasksByBatch.has(batchId)) tasksByBatch.set(batchId, []);
    tasksByBatch.get(batchId).push({ id: Number(row.id), status: row.status });
  }
  const runsByBatch = new Map();
  for (const row of db.prepare(`
    SELECT tc.import_batch_id, gr.*
    FROM generation_runs gr
    JOIN task_configs tc ON tc.task_id = gr.task_id
    WHERE tc.import_batch_id IS NOT NULL
    ORDER BY gr.id
  `).all()) {
    const batchId = Number(row.import_batch_id);
    if (!runsByBatch.has(batchId)) runsByBatch.set(batchId, []);
    runsByBatch.get(batchId).push(rowToStatisticsRun(row));
  }
  return { tasksByBatch, runsByBatch };
}

function batchStatistics(db, row, now, grouped = null) {
  const batchId = Number(row.id);
  const tasks = grouped?.tasksByBatch.get(batchId) ?? db.prepare(`
    SELECT t.id, t.status
    FROM task_configs tc JOIN tasks t ON t.id = tc.task_id
    WHERE tc.import_batch_id = ?
    ORDER BY t.id
  `).all(row.id).map((task) => ({ id: Number(task.id), status: task.status }));
  const runs = grouped?.runsByBatch.get(batchId) ?? db.prepare(`
    SELECT gr.*
    FROM generation_runs gr
    JOIN task_configs tc ON tc.task_id = gr.task_id
    WHERE tc.import_batch_id = ?
    ORDER BY gr.id
  `).all(row.id).map(rowToStatisticsRun);
  return summarizeImportBatchStatistics({
    batch: { id: Number(row.id), committedAt: row.committed_at },
    tasks,
    runs,
    now,
  });
}

export function createProductionStatisticsStore(db) {
  return {
    getImportBatchStatistics(batchId, { now = new Date() } = {}) {
      const row = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId);
      return row ? batchStatistics(db, row, now) : null;
    },

    getImportBatchStatisticsMap(batchIds, { now = new Date() } = {}) {
      if (!Array.isArray(batchIds) || batchIds.length > 100
        || batchIds.some((id) => !Number.isInteger(id) || id < 1)) {
        throw new TypeError('batchIds must contain at most 100 positive integers');
      }
      if (batchIds.length === 0) return new Map();
      const placeholders = batchIds.map(() => '?').join(', ');
      const rows = db.prepare(`SELECT * FROM import_batches WHERE id IN (${placeholders})`).all(...batchIds);
      const grouped = groupedStatisticsRows(db);
      return new Map(rows.map((row) => [
        Number(row.id),
        batchStatistics(db, row, now, grouped),
      ]));
    },

    listProductionStatistics({ page = 1, pageSize = 20, now = new Date() } = {}) {
      const normalizedPage = Math.max(1, Math.floor(Number(page) || 1));
      const normalizedPageSize = Math.max(1, Math.min(100, Math.floor(Number(pageSize) || 20)));
      const totalItems = Number(db.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count);
      const allRows = db.prepare('SELECT * FROM import_batches ORDER BY id DESC').all();
      const grouped = groupedStatisticsRows(db);
      const rows = db.prepare(`
        SELECT * FROM import_batches ORDER BY id DESC LIMIT ? OFFSET ?
      `).all(normalizedPageSize, (normalizedPage - 1) * normalizedPageSize);
      const batches = rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        status: row.status,
        createdAt: row.created_at,
        committedAt: row.committed_at,
        statistics: batchStatistics(db, row, now, grouped),
      }));
      const overview = allRows.map((row) => ({ statistics: batchStatistics(db, row, now, grouped) }))
        .reduce((summary, item) => {
        summary.taskCount += item.statistics.taskCount;
        summary.finishedTaskCount += item.statistics.finishedTaskCount;
        summary.qualityRepairAttempts += item.statistics.qualityRepairAttempts;
        summary.qualityRepairRuns += item.statistics.qualityRepairRuns;
        summary.qualityRepairTargetReached += item.statistics.qualityRepairTargetReached;
        for (const score of [0, 1, 2, 3]) {
          summary.initialScoreCounts[score] += item.statistics.initialScoreCounts[score];
          summary.finalScoreCounts[score] += item.statistics.finalScoreCounts[score];
        }
        return summary;
      }, {
        taskCount: 0,
        finishedTaskCount: 0,
        qualityRepairAttempts: 0,
        qualityRepairRuns: 0,
        qualityRepairTargetReached: 0,
        initialScoreCounts: scoreCounts(),
        finalScoreCounts: scoreCounts(),
      });
      return {
        overview,
        batches,
        pagination: {
          page: normalizedPage,
          pageSize: normalizedPageSize,
          totalItems,
          totalPages: Math.ceil(totalItems / normalizedPageSize),
        },
      };
    },
  };
}
