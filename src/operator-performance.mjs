import { summarizeAccountQuality } from './account-quality-statistics.mjs';
import { isQaActivity, qaMetricRows, summarizeQa, uniqueTaskCount, validQaReview } from './quality-review-statistics.mjs';
import { chinaDay, normalizeRange } from './web-statistics/summary.mjs';

export const PERFORMANCE_VERSION = 9;
export const PERFORMANCE_METRICS = Object.freeze(['judged','discarded','firstPassed','qualityReturned','reassigned','annotationOverall','all','contributed','qaAll','qa','qaRecheck','qaBatch','qaSpecial','qaPending','qaBlocked','submitted','firstSubmitted','firstPass','recheck','firstRecheck','returned','reworked','reassign','released','delivered','batchAffected','excluded','pending']);
export const PERFORMANCE_SORTS = Object.freeze(['contributed','qa','qaPending','submitted','released','judged','firstPassRate','overallPassRate','returnRate','discardedRate','copyRate','imageRate','returned','pending','copyMedian','imageMedian','copySubmitted','imageSubmitted','copyQa','imageQa','qaReviews','qaPassed','qaReturned','qaRecheck','reworked']);
const ms = value => value == null ? NaN : Date.parse(value);
const uniqueTasks = rows => new Set(rows.map(row => row.taskId)).size;
const valid = row => !row.exclusion && row.accountId !== null;
const inRange = (row, range) => ms(row.at) >= range.startMs && ms(row.at) < range.endMs;
const returned = row => valid(row) && (row.kind === 'RETURN' || row.kind === 'QUALITY' && row.outcome === 'RETURN');

function choice(value, values, fallback) {
  if (value === undefined || value === '') return fallback;
  if (!values.includes(value)) throw new TypeError('统计筛选值无效');
  return value;
}
function integer(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/u.test(String(value))) throw new TypeError('统计编号或页码无效');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new TypeError('统计编号或页码无效');
  return n;
}
export function normalizePerformanceFilters(input = {}, now = Date.now()) {
  const keys = ['period','from','to','accountId','stage','batchId','query','page','pageSize','sort','order','metric','sampleSet','snapshotToken','activity'];
  if (Object.keys(input).some(key => !keys.includes(key)) || Object.values(input).some(Array.isArray)) throw new TypeError('统计筛选参数无效');
  const period = choice(input.period, ['today','7d','30d','custom'], '30d');
  const query = String(input.query ?? '').trim();
  if (query.length > 128) throw new TypeError('搜索内容过长');
  if (input.snapshotToken && !/^[a-f0-9-]{36}$/u.test(input.snapshotToken)) throw new TypeError('统计快照无效');
  return { period, range: normalizeRange({ period, from:input.from,to:input.to }, now),
    accountId:integer(input.accountId,null),stage:choice(input.stage,['COPY','IMAGE'],''),batchId:integer(input.batchId,null),query,
    page:integer(input.page,1,1_000_000),pageSize:integer(input.pageSize,20,100),
    activity:choice(input.activity,['ALL','PRODUCTION','QA'],'ALL'),
    sort:choice(input.sort,PERFORMANCE_SORTS,'contributed'),order:choice(input.order,['asc','desc'],'desc'),
    metric:choice(input.metric,PERFORMANCE_METRICS,'all'),sampleSet:choice(input.sampleSet,['all','passed','failed','first'],'all'),
    snapshotToken:input.snapshotToken || null };
}

export function durationDistribution(values, missing = 0) {
  const ordered = values.filter(value => Number.isFinite(value) && value >= 0).toSorted((a,b) => a-b);
  const n = ordered.length;
  return { samples:n,missing,meanMs:n ? Math.round(ordered.reduce((sum,value)=>sum+value,0)/n):null,
    medianMs:n ? (ordered[Math.floor((n-1)/2)]+ordered[Math.floor(n/2)])/2:null,
    p90Ms:n ? ordered[Math.ceil(n*.9)-1]:null };
}

// All timeline segments are exclusive per task. They represent elapsed workflow
// time, never employee working hours. Baselines cannot establish a full cycle.
export function submissionTiming(event, timeline) {
  const end = ms(event.at);
  const previous = ms(event.previousSubmittedAt);
  const earlier = timeline.filter(item => item.taskId === event.taskId && ms(item.at) <= end)
    .toSorted((a,b) => ms(a.at)-ms(b.at) || a.id-b.id);
  let start = Number.isFinite(previous) ? previous : null;
  if (start === null) {
    const first = earlier.find(item => item.stage === event.stage);
    if (!first || first.baseline) return { humanMs:null,backgroundMs:null,qualityWaitMs:null,reason:'UNKNOWN_START' };
    start = ms(first.at);
  }
  const covering = earlier.findLast(item => ms(item.at) <= start);
  if (!covering || covering.baseline && ms(covering.at) > (Number.isFinite(previous) ? previous : -Infinity)) {
    return {humanMs:null,backgroundMs:null,qualityWaitMs:null,reason:'UNKNOWN_START'};
  }
  let humanMs=0,backgroundMs=0,qualityWaitMs=0,ownSegment=false;
  for (let i=0;i<earlier.length;i++) {
    const item=earlier[i], next=earlier[i+1];
    const elapsed=Math.max(0,Math.min(end,next ? ms(next.at):end)-Math.max(start,ms(item.at)));
    if (item.stage!==event.stage || !elapsed) continue;
    if (item.accountId===event.accountId && item.phase==='HUMAN') { humanMs+=elapsed;ownSegment=true; }
    if (['BACKGROUND','MACHINE_QUEUE','MACHINE_RUNNING'].includes(item.phase)) backgroundMs+=elapsed;
    if (item.phase==='QUALITY_WAIT') qualityWaitMs+=elapsed;
  }
  return {humanMs:ownSegment ? humanMs:null,backgroundMs,qualityWaitMs,reason:ownSegment ? null:'NO_OWN_INTERVAL'};
}

export function qualityRate(rows, first = true) {
  const samples=rows.filter(row=>row.kind==='QUALITY' && valid(row)
    && (first ? row.first===true && row.sampleKind==='RANDOM' : row.sampleKind==='MANDATORY_RECHECK')
    && ['PASS','RETURN'].includes(row.outcome));
  const passed=samples.filter(row=>row.outcome==='PASS').length;
  return {passed,failed:samples.length-passed,decided:samples.length,rate:samples.length ? passed/samples.length:null};
}

function latestRecheckPasses(history) {
  const latestRecheckPass=new Map();
  for(const row of history) if(row.kind==='QUALITY' && valid(row) && row.sampleKind==='MANDATORY_RECHECK' && row.outcome==='PASS') {
    const at=ms(row.at),key=`${row.taskId}:${row.stage}`;
    if(Number.isFinite(at) && at>(latestRecheckPass.get(key)??-Infinity)) latestRecheckPass.set(key,at);
  }
  return latestRecheckPass;
}

export function overallQualityRate(rows, history = rows, knownRecheckPasses = null) {
  const samples=rows.filter(row=>row.kind==='QUALITY' && valid(row) && row.first===true
    && row.sampleKind==='RANDOM' && ['PASS','RETURN'].includes(row.outcome));
  const latestRecheckPass=knownRecheckPasses??latestRecheckPasses(history);
  const passed=samples.filter(sample=>sample.outcome==='PASS'
    || (latestRecheckPass.get(`${sample.taskId}:${sample.stage}`)??-Infinity)>=ms(sample.at)).length;
  return {passed,failed:samples.length-passed,decided:samples.length,rate:samples.length ? passed/samples.length:null};
}

// Count every valid QA verdict attributed to the annotation account.
// Date filtering happens on the verdict timestamp, including repeat verdicts
// for the same content on the same Beijing day.
export function summarizeAnnotationOverall(rows) {
  const facts=rows.filter(row=>row.kind==='ANNOTATION_QUALITY' && !row.exclusion
    && Number.isSafeInteger(row.accountId) && row.accountId>0
    && ['PASS','RETURN'].includes(row.outcome) && Number.isFinite(ms(row.at)));
  const passed=facts.filter(row=>row.outcome==='PASS');
  const firstPassed=passed.filter(row=>row.firstPassed===true).length;
  const decided=facts.length,reworkPassed=passed.length-firstPassed,failed=decided-passed.length;
  return {firstPassed,reworkPassed,passed:passed.length,failed,decided,
    firstPassRate:decided?firstPassed/decided:0,rate:decided?passed.length/decided:0,
    returnRate:decided?failed/decided:0};
}

export function performanceMetricRows(rows, metric, stage='', sampleSet='all') {
  if (metric.startsWith('qa')) return sampleSet==='first' ? []
    : qaMetricRows(rows,metric,stage,sampleSet==='all'?'':sampleSet==='passed'?'PASS':'RETURN');
  return rows.filter(row=>(!stage || row.stage===stage) && (
    metric==='contributed' && (row.kind==='SUBMIT' && valid(row) || validQaReview(row))
    || metric==='all' || metric==='submitted' && row.kind==='SUBMIT' && valid(row)
    || metric==='firstSubmitted' && row.kind==='SUBMIT' && row.firstSubmission && valid(row)
    || metric==='firstPass' && row.kind==='QUALITY' && row.first && row.sampleKind==='RANDOM' && valid(row)
    || metric==='recheck' && row.kind==='QUALITY' && row.sampleKind==='MANDATORY_RECHECK' && valid(row)
    || metric==='firstRecheck' && row.kind==='QUALITY' && row.firstRecheck && valid(row)
    || metric==='returned' && returned(row)
    || metric==='reworked' && row.kind==='SUBMIT' && row.rework && valid(row)
    || metric==='released' && row.kind==='RELEASE' && row.first && valid(row)
    || metric==='delivered' && row.kind==='DELIVERY' && valid(row)
    || metric==='batchAffected' && row.kind==='BATCH_RETURN'
    || metric==='excluded' && (!valid(row) || row.kind==='EXCLUDED')
    || metric==='pending' && row.kind==='PENDING'
    || metric==='reassign' && row.kind==='REASSIGN'
    || metric==='judged' && row.kind==='ACCOUNT_QUALITY'
    || metric==='discarded' && row.kind==='ACCOUNT_QUALITY' && row.bucket==='DISCARDED'
    || metric==='firstPassed' && row.kind==='ACCOUNT_QUALITY' && row.bucket==='FIRST_PASS'
    || metric==='qualityReturned' && row.kind==='ACCOUNT_QUALITY' && row.bucket==='RETURNED'
    || metric==='reassigned' && row.kind==='ACCOUNT_QUALITY' && row.reassigned
    || metric==='annotationOverall' && row.kind==='ANNOTATION_QUALITY'
  ) && (sampleSet==='all' || sampleSet==='first' && metric==='annotationOverall' && row.firstPassed===true
    || sampleSet==='passed' && row.outcome==='PASS' || sampleSet==='failed' && row.outcome==='RETURN'));
}

export function summarizeOperator(rows, current=[], qualityHistory=rows, qualityHistoryByStage=null, knownRecheckPasses=null) {
  const qa=summarizeQa(rows);
  const submissions=rows.filter(row=>row.kind==='SUBMIT' && valid(row));
  const returns=rows.filter(returned);
  const reworks=submissions.filter(row=>row.rework);
  const stage=kind=>{
    const selected=rows.filter(row=>row.stage===kind), submitted=submissions.filter(row=>row.stage===kind);
    const durations=submitted.map(row=>row.timing?.humanMs).filter(value=>value!=null);
    const firstSubmissions=submitted.filter(row=>row.firstSubmission);
    const eligible=firstSubmissions.filter(row=>typeof row.sampleSelected==='boolean');
    const sampled=eligible.filter(row=>row.sampleSelected).length;
    return { qualityOutcomes:summarizeAccountQuality(selected),annotationOverallPass:summarizeAnnotationOverall(selected), submitted:uniqueTasks(submitted),submissions:submitted.length,
      firstSubmitted:uniqueTasks(firstSubmissions),reworked:uniqueTasks(submitted.filter(row=>row.rework)),
      reworkSubmissions:submitted.filter(row=>row.rework).length,
      returned:uniqueTasks(selected.filter(returned)),
      firstPass:qualityRate(selected),overallPass:overallQualityRate(selected,
        qualityHistoryByStage?.[kind]??qualityHistory.filter(row=>row.stage===kind),knownRecheckPasses),
      recheck:qualityRate(selected,false),firstRecheck:qualityRate(selected.filter(row=>row.firstRecheck),false),
      duration:durationDistribution(durations,submitted.length-durations.length),
      qualityWait:durationDistribution(selected.filter(row=>row.kind==='QUALITY' && valid(row))
        .map(row=>ms(row.at)-ms(row.submittedAt))),
      coverage:{eligible:eligible.length,sampled,unresolved:firstSubmissions.length-eligible.length,rate:eligible.length?sampled/eligible.length:null},
      pending:selected.filter(row=>row.kind==='PENDING').length,
      excluded:selected.filter(row=>!isQaActivity(row) && (!valid(row) || row.kind==='EXCLUDED')).length };
  };
  const returnDurations=reworks.map(row=>ms(row.at)-ms(row.returnedAt)).filter(Number.isFinite);
  const reasons=new Map();
  for(const row of returns) for(const code of new Set(row.reasons ?? [])) reasons.set(code,(reasons.get(code)??0)+1);
  return { qualityOutcomes:summarizeAccountQuality(rows),annotationOverallPass:summarizeAnnotationOverall(rows), contributed:uniqueTaskCount([...submissions,...qaMetricRows(rows)]),qa,submitted:uniqueTasks(submissions),submissions:submissions.length,
    delivered:uniqueTasks(rows.filter(row=>row.kind==='DELIVERY'&&valid(row))),
    deliveredBatches:new Set(rows.filter(row=>row.kind==='DELIVERY'&&valid(row)).map(row=>row.deliveryBatchId)).size,
    released:uniqueTasks(rows.filter(row=>row.kind==='RELEASE' && row.first && valid(row))),
    rereleased:uniqueTasks(rows.filter(row=>row.kind==='RELEASE' && !row.first && valid(row))),
    returned:uniqueTasks(returns),returnRounds:returns.length,
    repeatedReturns:uniqueTasks(returns.filter(row=>row.returnRound>=2)),
    reworked:uniqueTasks(reworks),reworkRounds:reworks.length,
    reassignSuggested:uniqueTasks(rows.filter(row=>row.kind==='REASSIGN')),
    batchAffected:uniqueTasks(rows.filter(row=>row.kind==='BATCH_RETURN')),
    reworkDuration:durationDistribution(returnDurations,reworks.length-returnDurations.length),
    pending:current.filter(row=>row.phase==='HUMAN').length,
    waitingQuality:current.filter(row=>row.phase==='QUALITY_WAIT').length,
    longWaiting:current.filter(row=>row.phase==='HUMAN' && row.waitingMs>=86_400_000).length,
    COPY:stage('COPY'),IMAGE:stage('IMAGE'),
    reasons:[...reasons].map(([code,count])=>({code,count})).sort((a,b)=>b.count-a.count).slice(0,10) };
}

export function buildPerformanceSnapshot(events,current,timeline,filters,asOf,qualityHistory=events,roster=[]) {
  const keyword=filters.query.toLocaleLowerCase('zh-CN');
  const nameMatches=row=>`${row.displayName??''} ${row.username??''}`.toLocaleLowerCase('zh-CN').includes(keyword);
  const matchingAccounts=new Set([...events,...current,...roster].filter(nameMatches).map(row=>row.accountId).filter(id=>id!==null));
  const matches=row=>(!filters.accountId || row.accountId===filters.accountId)
    && (!filters.stage || row.stage===filters.stage) && (!filters.batchId || row.batchId===filters.batchId)
    && (filters.activity==='QA' ? isQaActivity(row) : filters.activity==='PRODUCTION' ? !isQaActivity(row) : true)
    && (!keyword || (row.accountId===null ? nameMatches(row):matchingAccounts.has(row.accountId)));
  const rows=events.filter(row=>matches(row) && (['PENDING','EXCLUDED','QA_PENDING','REASSIGN'].includes(row.kind) || inRange(row,filters.range)));
  const history=qualityHistory.filter(row=>row.kind==='QUALITY' && inRange(row,filters.range)
    && (!filters.stage || row.stage===filters.stage) && (!filters.batchId || row.batchId===filters.batchId));
  const historyByTask=new Map();
  for(const item of timeline) { if(!historyByTask.has(item.taskId)) historyByTask.set(item.taskId,[]);historyByTask.get(item.taskId).push(item); }
  for(const row of rows) if(row.kind==='SUBMIT' && valid(row)) row.timing=submissionTiming(row,historyByTask.get(row.taskId)??[]);
  const present=current.filter(matches);
  const identities=new Map();
  for(const row of [...rows,...present]) if(row.accountId!==null) identities.set(row.accountId,
    {accountId:row.accountId,username:row.username,displayName:row.displayName||row.username||`历史账号 #${row.accountId}`});
  for(const row of roster) if(Number.isSafeInteger(row.accountId) && row.accountId>0
    && (!filters.accountId || row.accountId===filters.accountId) && (!keyword || matchingAccounts.has(row.accountId))) identities.set(row.accountId,
    {accountId:row.accountId,username:row.username,displayName:row.displayName||row.username||`账号 #${row.accountId}`});
  const byAccount=items=>{
    const grouped=new Map();
    for(const row of items) if(row.accountId!==null) {
      if(!grouped.has(row.accountId)) grouped.set(row.accountId,[]);
      grouped.get(row.accountId).push(row);
    }
    return grouped;
  };
  const rowsByAccount=byAccount(rows),currentByAccount=byAccount(present);
  const historyByStage={COPY:history.filter(row=>row.stage==='COPY'),IMAGE:history.filter(row=>row.stage==='IMAGE')};
  const knownRecheckPasses=latestRecheckPasses(history);
  const emptySummary=summarizeOperator([],[],[],historyByStage,knownRecheckPasses);
  const people=[...identities.values()].map(person=>({...person,
    ...(rowsByAccount.has(person.accountId)||currentByAccount.has(person.accountId)
      ? summarizeOperator(rowsByAccount.get(person.accountId)??[],currentByAccount.get(person.accountId)??[],history,historyByStage,knownRecheckPasses)
      : emptySummary)}));
  const rowsByDay=new Map();
  for(const row of rows) {
    const at=ms(row.at);
    if(!Number.isFinite(at)) continue;
    const date=chinaDay(at);
    if(!rowsByDay.has(date)) rowsByDay.set(date,[]);
    rowsByDay.get(date).push(row);
  }
  const trend=[];
  for(let at=filters.range.startMs;at<filters.range.endMs;at+=86_400_000) {
    const date=chinaDay(at),day=rowsByDay.get(date)??[],qaDay=summarizeQa(day);
    trend.push({date,qa:qaDay.reviews,submitted:uniqueTasks(day.filter(row=>row.kind==='SUBMIT'&&valid(row))),
      copySubmitted:uniqueTasks(day.filter(row=>row.kind==='SUBMIT'&&row.stage==='COPY'&&valid(row))),
      imageSubmitted:uniqueTasks(day.filter(row=>row.kind==='SUBMIT'&&row.stage==='IMAGE'&&valid(row))),
      copyQa:qaDay.COPY.tasks,imageQa:qaDay.IMAGE.tasks,
      released:uniqueTasks(day.filter(row=>row.kind==='RELEASE'&&row.first&&valid(row))),COPY:qualityRate(day.filter(row=>row.stage==='COPY')),IMAGE:qualityRate(day.filter(row=>row.stage==='IMAGE'))});
  }
  const exclusions=new Map();
  for(const row of rows) if(row.exclusion && !isQaActivity(row)) exclusions.set(row.exclusion,(exclusions.get(row.exclusion)??0)+1);
  return {metricVersion:PERFORMANCE_VERSION,timezone:'Asia/Shanghai',asOf,
    range:{from:filters.range.from,to:filters.range.to},filters,
    summary:summarizeOperator(rows,present,history,historyByStage,knownRecheckPasses),people,trend,rows,
    dataQuality:{unknownIdentity:rows.filter(row=>row.accountId===null
      && !['QA_PENDING','ANNOTATION_UNKNOWN_BATCH'].includes(row.kind)).length,
      unattributedAnnotationBatchReturns:rows.filter(row=>row.kind==='ANNOTATION_UNKNOWN_BATCH')
        .reduce((sum,row)=>sum+(Number.isSafeInteger(row.unknownCount)&&row.unknownCount>0?row.unknownCount:0),0),
      unattributedAnnotationBatchScopes:rows.filter(row=>row.kind==='ANNOTATION_UNKNOWN_BATCH' && row.unknownScope).length,
      excluded:[...exclusions].map(([reason,count])=>({reason,count})),
      timingSince:timeline.length ? timeline.reduce((min,row)=>row.at<min?row.at:min,timeline[0].at):null,
      historyNotice:'账号通过率按北京时间质检结论日统计实际标注账号的每次有效通过或打回判定；同一内容当天多次有效判定分别计入。整批打回按受影响内容记退回，单次操作不重复计触发项。首检废弃率沿用首次质检日口径。质检操作通过率单独归实际质检账号。缺失历史身份和时间不补造。'} };
}

export function combinedOverallPass(person) {
  return person.annotationOverallPass;
}

export function combinedQaPass(person) {
  const passed=person.qa.passed;
  const failed=person.qa.returned+person.qa.batchImpactReturns;
  const decided=passed+failed;
  return {passed,failed,decided,rate:decided ? passed/decided:0};
}

export function performancePeoplePage(snapshot,filters) {
  const value=(person,key)=>({contributed:person.contributed,qa:person.qa.reviews,qaPending:person.qa.pending,submitted:person.submitted,released:person.released,
    judged:person.annotationOverallPass.decided,firstPassRate:person.annotationOverallPass.firstPassRate,
    overallPassRate:(filters.activity==='QA'?combinedQaPass(person):combinedOverallPass(person)).rate,
    returnRate:person.annotationOverallPass.returnRate,discardedRate:person.qualityOutcomes.discardedRate??0,
    copyRate:person.COPY.annotationOverallPass.firstPassRate,
    imageRate:person.IMAGE.annotationOverallPass.firstPassRate,returned:person.returned,pending:person.pending,
    copyMedian:person.COPY.duration.medianMs,imageMedian:person.IMAGE.duration.medianMs,
    copySubmitted:person.COPY.submitted,imageSubmitted:person.IMAGE.submitted,copyQa:person.qa.COPY.tasks,imageQa:person.qa.IMAGE.tasks,
    qaReviews:person.qa.reviews,qaPassed:person.qa.passed,qaReturned:person.qa.returned,qaRecheck:person.qa.rechecks,reworked:person.reworked})[key];
  const rows=snapshot.people.toSorted((a,b)=>{
    const av=value(a,filters.sort),bv=value(b,filters.sort);
    if(av==null || bv==null) return av==null && bv==null ? a.accountId-b.accountId:av==null?1:-1;
    return (av-bv)*(filters.order==='asc'?1:-1) || a.accountId-b.accountId;
  });
  const page=Math.min(filters.page,Math.max(1,Math.ceil(rows.length/filters.pageSize)));
  return {items:rows.slice((page-1)*filters.pageSize,page*filters.pageSize),total:rows.length,page,pageSize:filters.pageSize};
}

export function performanceCsv(snapshot) {
  const cell=value=>`"${String(value??'').replace(/^[\s]*[=+@-]/u,match=>`'${match}`).replaceAll('"','""')}"`;
  const annotationStage={COPY:'文案',IMAGE:'图片'}[snapshot.filters.stage];
  const annotationPrefix=annotationStage??'标注';
  const annotationHeading=[`${annotationPrefix}一次通过次数`,`${annotationPrefix}返修通过次数`,
    `${annotationPrefix}通过次数`,`${annotationPrefix}已判定项次`,`${annotationPrefix}整体通过率`,
    `${annotationPrefix}一次通过率`,`${annotationPrefix}打回次数`,`${annotationPrefix}打回率`];
  const heading=['账号ID','姓名','账号','文案提交任务','图片提交任务','首次放行','文案通过','文案已审','图片通过','图片已审','退回任务','返修提交次数','文案周转中位毫秒','图片周转中位毫秒','当前待办','开始日期','结束日期','时区','报表时点','口径版本','交付确认任务','交付确认批次','文案抽中','文案已结批首次提交','图片抽中','图片已结批首次提交','文案时长缺失','图片时长缺失','批次退回影响','文案排除记录','图片排除记录'];
  heading.push('参与处理作业','文案质检次数','图片质检次数','质检作业','质检通过次数','质检退回次数','整批波及退回项次','整体退回项次','其中复检次数','批量退回次数','已知批量影响作业','旧批量影响项次','批量范围缺失次数','批量数量缺失次数','快捷直放次数','质检废弃次数','质检待办','质检阻塞','贡献视图');
  heading.push('文案首次标注条数','图片首次标注条数','文案返修条数','图片返修条数','文案质检条数','图片质检条数','文案首次返修通过','文案首次返修已检','图片首次返修通过','图片首次返修已检','当前建议改派','文案首次抽检最终通过','文案首次抽检已审','图片首次抽检最终通过','图片首次抽检已审',
    '账号质检操作通过','账号质检操作判定项次','账号质检操作通过率',...annotationHeading);
  for(const stage of ['文案','图片']) {
    heading.push(...['已判定项次','一次通过次数','返修通过次数','通过次数','打回次数','一次通过率','整体通过率','打回率']
      .map(label=>`${stage}质检日${label}`));
    heading.push(...['已判定','废弃','一次通过','打回','已二次分配','废弃率','一次通过率','打回率']
      .map(label=>`${stage}首检${label}`));
  }
  heading.push('提交管理员次数');
  return '\uFEFF'+[heading,...snapshot.people.map(p=>{const overall=combinedOverallPass(p),qaOverall=combinedQaPass(p);return [p.accountId,p.displayName,p.username,p.COPY.submitted,p.IMAGE.submitted,p.released,
    p.COPY.firstPass.passed,p.COPY.firstPass.decided,p.IMAGE.firstPass.passed,p.IMAGE.firstPass.decided,p.returned,p.reworkRounds,
    p.COPY.duration.medianMs,p.IMAGE.duration.medianMs,p.pending,snapshot.range.from,snapshot.range.to,snapshot.timezone,snapshot.asOf,snapshot.metricVersion,
    p.delivered,p.deliveredBatches,p.COPY.coverage.sampled,p.COPY.coverage.eligible,p.IMAGE.coverage.sampled,p.IMAGE.coverage.eligible,
    p.COPY.duration.missing,p.IMAGE.duration.missing,p.batchAffected,p.COPY.excluded,p.IMAGE.excluded,p.contributed,p.qa.COPY.reviews,p.qa.IMAGE.reviews,p.qa.tasks,p.qa.passed,p.qa.returned,p.qa.batchImpactReturns,qaOverall.failed,p.qa.rechecks,p.qa.batchActions,p.qa.affectedTasks,p.qa.legacyAffectedCount,p.qa.unknownBatchScopes,p.qa.unknownBatchCounts,p.qa.directPass,p.qa.discarded,p.qa.pending,p.qa.blocked,snapshot.filters.activity,
    p.COPY.firstSubmitted,p.IMAGE.firstSubmitted,p.COPY.reworked,p.IMAGE.reworked,p.qa.COPY.tasks,p.qa.IMAGE.tasks,
    p.COPY.firstRecheck.passed,p.COPY.firstRecheck.decided,p.IMAGE.firstRecheck.passed,p.IMAGE.firstRecheck.decided,p.reassignSuggested,
    p.COPY.overallPass.passed,p.COPY.overallPass.decided,p.IMAGE.overallPass.passed,p.IMAGE.overallPass.decided,
    qaOverall.passed,qaOverall.decided,qaOverall.rate,overall.firstPassed,overall.reworkPassed,overall.passed,overall.decided,overall.rate,
    overall.firstPassRate,overall.failed,overall.returnRate,
    ...['COPY','IMAGE'].flatMap(stage=>{const day=p[stage].annotationOverallPass,q=p[stage].qualityOutcomes;
      return [day.decided,day.firstPassed,day.reworkPassed,day.passed,day.failed,day.firstPassRate,day.rate,day.returnRate,
        q.judged,q.discarded,q.firstPassed,q.returned,q.reassigned,q.discardedRate,q.firstPassRate,q.returnRate];}),p.qa.escalated];})]
    .map(row=>row.map(cell).join(',')).join('\r\n');
}
