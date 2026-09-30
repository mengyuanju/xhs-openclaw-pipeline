// Work counts valid submissions and direct discard decisions made in the workbench.
// Each assignment cycle has its own first operation and first submitted version.
// Date filters select operations; QA verdicts may arrive later, up to asOf.
import { chinaDay } from './web-statistics/summary.mjs';

function addTask(group,row) {
  if (!group.has(row.accountId)) group.set(row.accountId,new Set());
  group.get(row.accountId).add(row.taskId);
}

function intersectionSize(left,right) {
  let count=0;
  for (const taskId of left) if (right.has(taskId)) count++;
  return count;
}

function cycleKey(row) {
  return row.annotationCycleKey??`${row.stage}:${row.taskId}:${row.accountId}`;
}

function firstCopySummary(cycles,submissions,verdicts) {
  const result={passed:0,returned:0,qaDiscarded:0,decided:0,unjudged:0,directDiscarded:0,
    pending:0,bypassed:0,unjudgedOther:0};
  for (const key of cycles.keys()) {
    const verdict=verdicts.get(key);
    const submitted=verdict?.submitted??submissions.has(key);
    if (!submitted) {result.directDiscarded++;continue;}
    if (['PASS','RETURN','DISCARD'].includes(verdict?.outcome)) {
      result.decided++;
      if (verdict.outcome==='PASS') result.passed++;
      else if (verdict.outcome==='RETURN') result.returned++;
      else result.qaDiscarded++;
    } else {
      result.unjudged++;
      if (verdict?.reason==='PENDING') result.pending++;
      else if (['ADMIN_DIRECT','NOT_SELECTED'].includes(verdict?.reason)) result.bypassed++;
      else result.unjudgedOther++;
    }
  }
  return result;
}

export function buildAnnotationJobReport(snapshot, firstCopyVerdicts = []) {
  const workByAccount = new Map();
  const firstCopyCyclesByAccount = new Map();
  const firstCopyDatesByAccount = new Map();
  const firstCopyTasksByAccount = new Map();
  const firstCopySubmitsByAccount = new Map();
  const verdictsByAccount = new Map();
  const reworkTasksByAccount = new Map();
  const imageReworkTasksByAccount = new Map();
  const discardedTasks = new Map();
  const dailyByDate = new Map();
  const dailyRow = (date,accountId) => {
    if (!dailyByDate.has(date)) dailyByDate.set(date,new Map());
    const byAccount=dailyByDate.get(date);
    if (!byAccount.has(accountId)) byAccount.set(accountId,{date,accountId,totalJobs:0,copyReview:0,
      imageFirstReview:0,copyFirstPassed:0,copyDecided:0,copyFirstPassRate:null});
    return byAccount.get(accountId);
  };
  for (const row of snapshot.rows) if (['SUBMIT','ANNOTATION_DISCARD'].includes(row.kind)
    && !row.exclusion && row.accountId != null && row.taskId != null) {
    const first=row.annotationFirst??!row.rework;
    const key=cycleKey(row);
    const at=Date.parse(row.at);
    const date=chinaDay(at);
    const daily=dailyRow(date,row.accountId);
    daily.totalJobs++;
    if (first && row.stage==='COPY') daily.copyReview++;
    if (first && row.stage!=='COPY') daily.imageFirstReview++;
    const work=workByAccount.get(row.accountId)??{copyFirst:0,copyRework:0,imageFirst:0,imageRework:0};
    work[row.stage==='COPY'?(first?'copyFirst':'copyRework'):(first?'imageFirst':'imageRework')]++;
    workByAccount.set(row.accountId,work);
    if (row.kind==='ANNOTATION_DISCARD') addTask(discardedTasks,row);
    if (row.stage==='COPY' && row.kind==='SUBMIT') {
      if (!firstCopySubmitsByAccount.has(row.accountId)) firstCopySubmitsByAccount.set(row.accountId,new Set());
      firstCopySubmitsByAccount.get(row.accountId).add(key);
    }
    const tasks=row.stage==='COPY'?reworkTasksByAccount:imageReworkTasksByAccount;
    if (!first) addTask(tasks,row);
    else if (row.stage==='COPY') {
      addTask(firstCopyTasksByAccount,row);
      if (!firstCopyCyclesByAccount.has(row.accountId)) firstCopyCyclesByAccount.set(row.accountId,new Map());
      firstCopyCyclesByAccount.get(row.accountId).set(key,row.taskId);
      if (!firstCopyDatesByAccount.has(row.accountId)) firstCopyDatesByAccount.set(row.accountId,new Map());
      const firstDates=firstCopyDatesByAccount.get(row.accountId);
      if (at < (firstDates.get(key)?.at??Infinity)) firstDates.set(key,{at,date});
    }
  }
  for (const verdict of firstCopyVerdicts) {
    const key=verdict.cycleKey??`COPY:${verdict.taskId}:${verdict.accountId}`;
    if (firstCopyCyclesByAccount.get(verdict.accountId)?.get(key)!==verdict.taskId) continue;
    if (!verdictsByAccount.has(verdict.accountId)) verdictsByAccount.set(verdict.accountId,new Map());
    const verdicts=verdictsByAccount.get(verdict.accountId);
    if (['PASS','RETURN','DISCARD'].includes(verdicts.get(key)?.outcome)) continue;
    verdicts.set(key,verdict);
  }
  for (const [accountId,cycles] of firstCopyCyclesByAccount) {
    const firstDates=firstCopyDatesByAccount.get(accountId);
    const submits=firstCopySubmitsByAccount.get(accountId)??new Set();
    const verdicts=verdictsByAccount.get(accountId)??new Map();
    for (const key of cycles.keys()) {
      const verdict=verdicts.get(key);
      if (!(verdict?.submitted??submits.has(key))
        || !['PASS','RETURN','DISCARD'].includes(verdict?.outcome)) continue;
      const daily=dailyRow(firstDates.get(key).date,accountId);
      daily.copyDecided++;
      if (verdict.outcome==='PASS') daily.copyFirstPassed++;
    }
  }
  const dates=[];
  for (let at=Date.parse(`${snapshot.range.from}T00:00:00Z`),end=Date.parse(`${snapshot.range.to}T00:00:00Z`);
    at<=end;at+=86_400_000) dates.push(new Date(at).toISOString().slice(0,10));
  const trend={dates,rows:dates.flatMap(date=>[...(dailyByDate.get(date)?.values()??[])]
    .sort((a,b)=>a.accountId-b.accountId)
    .map(row=>({...row,copyFirstPassRate:row.copyDecided?row.copyFirstPassed/row.copyDecided:null})))};
  const people = snapshot.people.filter(person => workByAccount.has(person.accountId)
    || (discardedTasks.get(person.accountId)?.size ?? 0) > 0 || person.annotationOverallPass.decided > 0).map(person => {
    const work=workByAccount.get(person.accountId)??{copyFirst:0,copyRework:0,imageFirst:0,imageRework:0};
    const copyReview = work.copyFirst;
    const copyRework = work.copyRework;
    const imageFirstReview = work.imageFirst;
    const imageRework = work.imageRework;
    const imageReview = imageFirstReview + imageRework;
    const discarded = discardedTasks.get(person.accountId)?.size ?? 0;
    const firstCopy=firstCopySummary(firstCopyCyclesByAccount.get(person.accountId)??new Map(),
      firstCopySubmitsByAccount.get(person.accountId)??new Set(),verdictsByAccount.get(person.accountId)??new Map());
    const firstTasks=firstCopyTasksByAccount.get(person.accountId)??new Set();
    const reworkTasks=reworkTasksByAccount.get(person.accountId)??new Set();
    const reworkOfFirst=intersectionSize(firstTasks,reworkTasks);
    return {
      accountId:person.accountId,username:person.username,displayName:person.displayName,
      totalJobs:copyReview + copyRework + imageFirstReview + imageRework,
      copyReview,copyReviewTasks:firstTasks.size,copyRework,copyReworkTasks:reworkTasks.size,
      copyReworkOfFirstTasks:reworkOfFirst,copyReworkOtherTasks:reworkTasks.size-reworkOfFirst,
      imageReview,imageFirstReview,imageRework,
      imageReworkTasks:imageReworkTasksByAccount.get(person.accountId)?.size ?? 0,discarded,
      copyFirstPassRate:firstCopy.decided ? firstCopy.passed/firstCopy.decided : 0,
      copyFirstPassed:firstCopy.passed,
      copyDecided:firstCopy.decided,
      copyFirstReturned:firstCopy.returned,copyFirstQaDiscarded:firstCopy.qaDiscarded,
      copyFirstUnjudged:firstCopy.unjudged,copyFirstDirectDiscarded:firstCopy.directDiscarded,
      copyFirstPending:firstCopy.pending,copyFirstBypassed:firstCopy.bypassed,
      copyFirstUnjudgedOther:firstCopy.unjudgedOther,
      returned:person.annotationOverallPass.failed,
    };
  }).sort((a,b) => b.totalJobs-a.totalJobs || a.accountId-b.accountId);
  return {
    timezone:snapshot.timezone,asOf:snapshot.asOf,range:snapshot.range,
    summary:{workers:people.filter(person=>person.totalJobs>0).length,
      totalJobs:people.reduce((sum,person)=>sum+person.totalJobs,0),
      returned:people.reduce((sum,person)=>sum+person.returned,0)},
    people,trend,
    dataQuality:{unknownIdentity:snapshot.dataQuality.unknownIdentity,
      unattributedAnnotationBatchReturns:snapshot.dataQuality.unattributedAnnotationBatchReturns,
      unattributedAnnotationBatchScopes:snapshot.dataQuality.unattributedAnnotationBatchScopes},
  };
}
