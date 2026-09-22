export const isQaActivity = row => row.kind?.startsWith('QA_') === true;
export const validQaReview = row => ['QA_REVIEW','QA_ESCALATE'].includes(row.kind) && !row.exclusion
  && Number.isSafeInteger(row.accountId) && row.accountId > 0 && ['PASS','RETURN','ESCALATE'].includes(row.outcome);
export const uniqueTaskCount = rows => new Set(rows.map(row => row.taskId).filter(id => Number.isSafeInteger(id) && id > 0)).size;

export function qaMetricRows(rows, metric = 'qa', stage = '', outcome = '') {
  const seen = new Set();
  return rows.filter(row => {
    if (!isQaActivity(row) || stage && row.stage !== stage || outcome && row.outcome !== outcome) return false;
    const matches = metric === 'qaAll' || metric === 'qa' && validQaReview(row)
      || metric === 'qaRecheck' && validQaReview(row) && row.sampleKind === 'MANDATORY_RECHECK'
      || metric === 'qaBatch' && row.kind === 'QA_BATCH_RETURN' && !row.exclusion && row.accountId != null
      || metric === 'qaSpecial' && ['QA_DIRECT_PASS','QA_DISCARD'].includes(row.kind) && !row.exclusion && row.accountId != null
      || metric === 'qaPending' && row.kind === 'QA_PENDING' && !row.blocked
      || metric === 'qaBlocked' && row.kind === 'QA_PENDING' && row.blocked;
    const key = row.kind === 'QA_REVIEW' ? `${row.stage}:${row.samplingItemId ?? row.id}` : row.id;
    if (!matches || seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function summarizeQa(rows) {
  const reviews = qaMetricRows(rows), batches = qaMetricRows(rows,'qaBatch'), special = qaMetricRows(rows,'qaSpecial');
  const pending = [...qaMetricRows(rows,'qaPending'),...qaMetricRows(rows,'qaBlocked')];
  const stage = name => {
    const selected = reviews.filter(row => row.stage === name), waiting = pending.filter(row => row.stage === name);
    return { tasks:uniqueTaskCount(selected), reviews:selected.length, passed:selected.filter(row=>row.outcome==='PASS').length,
      returned:selected.filter(row=>row.outcome==='RETURN').length, escalated:selected.filter(row=>row.outcome==='ESCALATE').length, rechecks:selected.filter(row=>row.sampleKind==='MANDATORY_RECHECK').length,
      pending:waiting.filter(row=>!row.blocked).length, blocked:waiting.filter(row=>row.blocked).length,
      pendingRechecks:waiting.filter(row=>!row.blocked && row.sampleKind==='MANDATORY_RECHECK').length };
  };
  const knownBatches = batches.filter(row=>Array.isArray(row.affectedTaskIds));
  return { tasks:uniqueTaskCount(reviews), reviews:reviews.length,
    passed:reviews.filter(row=>row.outcome==='PASS').length, returned:reviews.filter(row=>row.outcome==='RETURN').length, escalated:reviews.filter(row=>row.outcome==='ESCALATE').length,
    rechecks:reviews.filter(row=>row.sampleKind==='MANDATORY_RECHECK').length, batchActions:batches.length,
    affectedTasks:new Set(knownBatches.flatMap(row=>row.affectedTaskIds)).size,
    unknownBatchScopes:batches.length-knownBatches.length,
    legacyAffectedCount:batches.filter(row=>!Array.isArray(row.affectedTaskIds)).reduce((sum,row)=>sum+(Number(row.affectedCount)||0),0),
    specialActions:special.length, directPass:special.filter(row=>row.kind==='QA_DIRECT_PASS').length,
    discarded:special.filter(row=>row.kind==='QA_DISCARD').length,
    participants:new Set([...reviews,...batches,...special].map(row=>row.accountId)).size,
    pending:pending.filter(row=>!row.blocked).length, blocked:pending.filter(row=>row.blocked).length,
    COPY:stage('COPY'), IMAGE:stage('IMAGE') };
}
