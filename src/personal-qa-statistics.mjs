import { qaMetricRows } from './quality-review-statistics.mjs';

const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const validActor = row => positive(row.accountId) && !row.exclusion;
const sourceOrder = ['DIRECT', 'BATCH_RETURN', 'BATCH_RELEASE'];

// A freeze contains one version of each task. A later recheck has its own
// freeze/item; taskId alone would incorrectly merge that work with the first check.
export function personalQaItemKey(row) {
  if (typeof row.reviewItemKey === 'string' && row.reviewItemKey) return row.reviewItemKey;
  if (row.stage === 'COPY' && (positive(row.qaBatchId) || String(row.id).startsWith('copy-v2:'))
    && positive(row.samplingItemId)) return `COPY:v2:${row.samplingItemId}`;
  if (positive(row.freezeId) && positive(row.taskId)) return `${row.stage}:legacy:${row.freezeId}:${row.taskId}`;
  if (positive(row.samplingItemId)) return `${row.stage}:legacy:item:${row.samplingItemId}`;
  return `${row.stage}:event:${row.id}`;
}

function mergeItem(items, row, source) {
  const key = personalQaItemKey(row), previous = items.get(key);
  const newest = !previous || Date.parse(row.at) > Date.parse(previous.at) ? row : previous;
  const coverageSources = sourceOrder.filter(value => value === source || previous?.coverageSources.includes(value));
  const manualKinds = [...new Set([...(previous?.manualKinds ?? []), ...(source === 'DIRECT' ? [row.kind] : [])])];
  const manualOutcomes = [...new Set([...(previous?.manualOutcomes ?? []), ...(source === 'DIRECT' ? [row.outcome] : [])])];
  items.set(key, { ...newest, id:`personal-qa:${key}`, reviewItemKey:key, coverageSources, manualKinds, manualOutcomes });
}

export function buildPersonalQaActivity(qaFacts, coverageFacts = [], stage = '') {
  const matchesStage = row => !stage || row.stage === stage;
  const direct = qaFacts.filter(row => matchesStage(row) && validActor(row)
    && (row.kind === 'QA_REVIEW' && ['PASS', 'RETURN'].includes(row.outcome)
      || row.kind === 'QA_ESCALATE' && row.outcome === 'ESCALATE' || row.kind === 'QA_DISCARD'));
  const actualMap = new Map(), coveredMap = new Map(), operations = new Set();
  for (const row of direct) mergeItem(actualMap, row, 'DIRECT');
  for (const row of actualMap.values()) coveredMap.set(row.reviewItemKey, { ...row });

  // The new member ledger carries exclusions per member. Its presence must
  // suppress the older whole-batch scope, including members excluded from QA.
  const capturedLegacyActions = new Set(coverageFacts.filter(row => row.kind === 'BATCH_RETURN'
    && row.sourceEventId != null).map(row => `${row.stage}:${row.sourceEventId}`));
  const capturedOperations = new Set(coverageFacts.filter(row => row.kind === 'BATCH_RETURN').map(row => row.operationKey));
  let coverageIncomplete = coverageFacts.some(row => matchesStage(row) && row.kind === 'COVERAGE_UNKNOWN');
  for (const row of coverageFacts) {
    if (!matchesStage(row) || !validActor(row) || !['BATCH_RETURN', 'BATCH_RELEASE'].includes(row.kind)) continue;
    mergeItem(coveredMap, row, row.kind);
    operations.add(row.operationKey ?? row.id);
  }
  for (const batch of qaMetricRows(qaFacts, 'qaBatch', stage)) {
    if (capturedLegacyActions.has(`${batch.stage}:${batch.sourceEventId}`)) continue;
    const operationKey = batch.operationKey ?? (batch.stage === 'COPY' && positive(batch.qaBatchId)
      ? `COPY:v2:${batch.qaBatchId}:BATCH_RETURN` : `${batch.stage}:legacy:return:${batch.sourceEventId ?? batch.id}`);
    operations.add(operationKey);
    if (capturedOperations.has(operationKey)) continue;
    const members = batch.affectedTaskIds;
    if (!Array.isArray(members) || !members.every(positive) || !positive(batch.freezeId)) {
      if (batch.affectedCount !== 0) coverageIncomplete = true;
      continue;
    }
    if (Number.isSafeInteger(batch.affectedCount) && batch.affectedCount !== new Set(members).size) coverageIncomplete = true;
    for (const taskId of new Set(members)) mergeItem(coveredMap, { ...batch, taskId,
      outcome:'RETURN', reviewItemKey:`${batch.stage}:legacy:${batch.freezeId}:${taskId}` }, 'BATCH_RETURN');
  }
  const actual = [...actualMap.values()], covered = [...coveredMap.values()];
  return { actual, covered, batchActions:operations.size, coverageIncomplete,
    returned:covered.filter(row => row.coverageSources.includes('BATCH_RETURN')),
    released:covered.filter(row => row.coverageSources.includes('BATCH_RELEASE')),
    discarded:actual.filter(row => row.manualKinds.includes('QA_DISCARD')),
    escalated:actual.filter(row => row.manualKinds.includes('QA_ESCALATE')) };
}

export function personalQaMetricRows(qaFacts, coverageFacts, metric, stage = '') {
  const activity = buildPersonalQaActivity(qaFacts, coverageFacts, stage);
  if (metric === 'qaCoverage') return activity.covered;
  if (metric === 'qaBatchReturned') return activity.returned;
  if (metric === 'qaBatchReleased') return activity.released;
  if (metric === 'qaDiscarded') return activity.discarded;
  if (metric === 'qaEscalated') return activity.escalated;
  if (metric === 'qaFirst') return activity.actual.filter(row => row.sampleKind !== 'MANDATORY_RECHECK');
  if (metric === 'qaRecheck') return activity.actual.filter(row => row.sampleKind === 'MANDATORY_RECHECK');
  if (metric === 'qaPassed') return activity.actual.filter(row => row.manualOutcomes.includes('PASS'));
  if (metric === 'qaReturned') return activity.actual.filter(row => row.manualOutcomes.includes('RETURN'));
  return activity.actual;
}

export function summarizePersonalQa(qaFacts, coverageFacts = [], stage = '') {
  const activity = buildPersonalQaActivity(qaFacts, coverageFacts, stage);
  return { firstReviews:activity.actual.filter(row => row.sampleKind !== 'MANDATORY_RECHECK').length,
    rechecks:activity.actual.filter(row => row.sampleKind === 'MANDATORY_RECHECK').length,
    passed:activity.actual.filter(row => row.manualOutcomes.includes('PASS')).length,
    returned:activity.actual.filter(row => row.manualOutcomes.includes('RETURN')).length,
    reviews:qaMetricRows(qaFacts, 'qa', stage).length,
    actualOperations:activity.actual.length, processingCoverage:activity.covered.length,
    batchReturned:activity.returned.length, batchReleased:activity.released.length,
    batchActions:activity.batchActions, discarded:activity.discarded.length, escalated:activity.escalated.length,
    coverageIncomplete:activity.coverageIncomplete };
}
