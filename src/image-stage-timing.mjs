import { DatabaseSync } from 'node:sqlite';
import { effectiveModelApiConfig } from './model-api-config.mjs';

const STAGES = ['PREPARING', 'PLANNING', 'GENERATING', 'QUALITY_CHECK', 'FINALIZING'];
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const MAX_DURATION = 24 * 60 * 60_000;

function validStages(value) {
  return value && STAGES.every((stage) => Number.isFinite(value[stage]) && value[stage] >= 0)
    && STAGES.reduce((sum, stage) => sum + value[stage], 0) >= 30_000
    && STAGES.reduce((sum, stage) => sum + value[stage], 0) <= MAX_DURATION;
}

export function imageTimingProfile({ provider, imageCount, concurrency, modelApi }) {
  const config = effectiveModelApiConfig(modelApi);
  return JSON.stringify({ version: 1, provider, imageCount, concurrency,
    textModel: config.textModel, imageModel: config.imageModel, visionModel: config.visionModel,
    qualityModel: config.qualityModel, thinking: config.copyGenerationThinking });
}

function history(databasePath, action, fallback) {
  let db;
  try {
    db = new DatabaseSync(databasePath);
    db.exec(`PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS image_timing (
        run_id TEXT PRIMARY KEY, profile TEXT NOT NULL, stages TEXT NOT NULL, finished_at INTEGER NOT NULL
      );`);
    return action(db);
  } catch { return fallback; } // Telemetry failure must never fail a delivery or replay a model.
  finally { db?.close(); }
}

export function readImageTimingSamples({ databasePath, profile }) {
  return history(databasePath, (db) => db.prepare(
    'SELECT stages FROM image_timing WHERE profile = ? ORDER BY finished_at DESC, rowid DESC LIMIT 30',
  ).all(profile).map((row) => JSON.parse(row.stages)).filter(validStages), []);
}

export function recordImageTimingSample({ databasePath, profile, stages, runId }) {
  if (!validStages(stages)) return false;
  return history(databasePath, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO image_timing (run_id, profile, stages, finished_at) VALUES (?, ?, ?, ?)')
        .run(runId, profile, JSON.stringify(stages), Date.now());
      db.prepare(`DELETE FROM image_timing WHERE rowid NOT IN
        (SELECT rowid FROM image_timing ORDER BY finished_at DESC, rowid DESC LIMIT 300)`).run();
      db.exec('COMMIT');
      return true;
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }, false);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function createImageStageTimer({ imageCount, concurrency = 2, thinking = 'low', samples = [] }) {
  if (!Number.isInteger(imageCount) || imageCount < 3 || imageCount > 5) throw new RangeError('imageCount must be 3-5');
  if (![1, 2].includes(concurrency)) throw new RangeError('image concurrency must be 1 or 2');
  const valid = samples.filter(validStages).slice(0, 30);
  const planning = { minimal: 30_000, low: 45_000, medium: 60_000, high: 90_000, xhigh: 120_000, max: 150_000 }[thinking] ?? 60_000;
  // Cold-start budgets, not measured guarantees. Page one establishes style before the remaining pages.
  const budget = { PREPARING: 5000, PLANNING: planning,
    GENERATING: 360_000 + Math.ceil((imageCount - 1) / concurrency) * 270_000,
    QUALITY_CHECK: 60_000, FINALIZING: 5000 };
  if (valid.length >= 3) for (const stage of STAGES) budget[stage] = median(valid.map((sample) => sample[stage]));
  let active = -1;
  let phaseStarted = 0;
  const durations = {};
  return {
    update(stage, elapsedMs) {
      const terminal = TERMINAL.has(stage);
      const next = terminal ? STAGES.length : STAGES.indexOf(stage === 'ALIGNING' ? 'GENERATING' : stage);
      if (next > active) {
        if (active >= 0 && active < STAGES.length) durations[STAGES[active]] = Math.max(0, elapsedMs - phaseStarted);
        active = next;
        phaseStarted = elapsedMs;
      }
      const inPhase = Math.max(0, elapsedMs - phaseStarted);
      const overdue = !terminal && active >= 0 && inPhase > budget[STAGES[active]];
      const remaining = terminal ? 0 : Math.max(0, budget[STAGES[active]] - inPhase)
        + STAGES.slice(active + 1).reduce((sum, item) => sum + budget[item], 0);
      return {
        estimatedTotalMs: Math.max(1000, elapsedMs + (overdue ? 0 : remaining)),
        estimatedRemainingMs: overdue ? null : remaining,
        estimatedStageDeadlineElapsedMs: terminal ? null : phaseStarted + budget[STAGES[active]],
        estimateOverdue: overdue,
        estimateBasis: valid.length >= 3 ? 'stage-history' : 'stage-defaults',
        estimateSampleSize: valid.length,
        stageDurationsMs: { ...durations },
      };
    },
  };
}
