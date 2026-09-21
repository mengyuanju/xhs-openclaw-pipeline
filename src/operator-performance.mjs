import { isQaActivity, qaMetricRows, summarizeQa, uniqueTaskCount, validQaReview } from './quality-review-statistics.mjs';
import { chinaDay, normalizeRange } from './web-statistics/summary.mjs';

export const PERFORMANCE_VERSION = 4;
export const PERFORMANCE_METRICS = Object.freeze(['all','contributed','qaAll','qa','qaRecheck','qaBatch','qaSpecial','qaPending','qaBlocked','submitted','firstSubmitted','firstPass','recheck','firstRecheck','returned','reworked','reassign','released','delivered','batchAffected','excluded','pending']);
export const PERFORMANCE_SORTS = Object.freeze(['contributed','qa','qaPending','submitted','released','copyRate','imageRate','returned','pending','copyMedian','imageMedian','copySubmitted','imageSubmitted','copyQa','imageQa','qaReviews','qaPassed','qaReturned','qaRecheck','reworked']);
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
    metric:choice(input.metric,PERFORMANCE_METRICS,'all'),sampleSet:choice(input.sampleSet,['all','passed','failed'],'all'),
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

export function overallQualityRate(rows, history = rows) {
  const samples=rows.filter(row=>row.kind==='QUALITY' && valid(row) && row.first===true
    && row.sampleKind==='RANDOM' && ['PASS','RETURN'].includes(row.outcome));
  const passed=samples.filter(sample=>sample.outcome==='PASS' || history.some(row=>row.kind==='QUALITY' && valid(row)
    && row.sampleKind==='MANDATORY_RECHECK' && row.outcome==='PASS' && row.taskId===sample.taskId
    && row.stage===sample.stage && ms(row.at)>=ms(sample.at))).length;
  return {passed,failed:samples.length-passed,decided:samples.length,rate:samples.length ? passed/samples.length:null};
}

export function performanceMetricRows(rows, metric, stage='', sampleSet='all') {
  if (metric.startsWith('qa')) return qaMetricRows(rows,metric,stage,sampleSet==='all'?'':sampleSet==='passed'?'PASS':'RETURN');
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
  ) && (sampleSet==='all' || row.outcome===(sampleSet==='passed'?'PASS':'RETURN')));
}

export function summarizeOperator(rows, current=[], qualityHistory=rows) {
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
    return { submitted:uniqueTasks(submitted),submissions:submitted.length,
      firstSubmitted:uniqueTasks(firstSubmissions),reworked:uniqueTasks(submitted.filter(row=>row.rework)),
      reworkSubmissions:submitted.filter(row=>row.rework).length,
      returned:uniqueTasks(selected.filter(returned)),
      firstPass:qualityRate(selected),overallPass:overallQualityRate(selected,qualityHistory.filter(row=>row.stage===kind)),
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
  return { contributed:uniqueTaskCount([...submissions,...qaMetricRows(rows)]),qa,submitted:uniqueTasks(submissions),submissions:submissions.length,
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

export function buildPerformanceSnapshot(events,current,timeline,filters,asOf) {
  const keyword=filters.query.toLocaleLowerCase('zh-CN');
  const nameMatches=row=>`${row.displayName??''} ${row.username??''}`.toLocaleLowerCase('zh-CN').includes(keyword);
  const matchingAccounts=new Set([...events,...current].filter(nameMatches).map(row=>row.accountId).filter(id=>id!==null));
  const matches=row=>(!filters.accountId || row.accountId===filters.accountId)
    && (!filters.stage || row.stage===filters.stage) && (!filters.batchId || row.batchId===filters.batchId)
    && (filters.activity==='QA' ? isQaActivity(row) : filters.activity==='PRODUCTION' ? !isQaActivity(row) : true)
    && (!keyword || (row.accountId===null ? nameMatches(row):matchingAccounts.has(row.accountId)));
  const rows=events.filter(row=>matches(row) && (['PENDING','EXCLUDED','QA_PENDING','REASSIGN'].includes(row.kind) || inRange(row,filters.range)));
  const historyByTask=new Map();
  for(const item of timeline) { if(!historyByTask.has(item.taskId)) historyByTask.set(item.taskId,[]);historyByTask.get(item.taskId).push(item); }
  for(const row of rows) if(row.kind==='SUBMIT' && valid(row)) row.timing=submissionTiming(row,historyByTask.get(row.taskId)??[]);
  const present=current.filter(matches);
  const identities=new Map();
  for(const row of [...rows,...present]) if(row.accountId!==null) identities.set(row.accountId,
    {accountId:row.accountId,username:row.username,displayName:row.displayName||row.username||`历史账号 #${row.accountId}`});
  const people=[...identities.values()].map(person=>({...person,
    ...summarizeOperator(rows.filter(row=>row.accountId===person.accountId),present.filter(row=>row.accountId===person.accountId),rows)}));
  const trend=[];
  for(let at=filters.range.startMs;at<filters.range.endMs;at+=86_400_000) {
    const date=chinaDay(at),day=rows.filter(row=>Number.isFinite(ms(row.at)) && chinaDay(ms(row.at))===date);
    trend.push({date,qa:summarizeQa(day).reviews,submitted:uniqueTasks(day.filter(row=>row.kind==='SUBMIT'&&valid(row))),
      copySubmitted:uniqueTasks(day.filter(row=>row.kind==='SUBMIT'&&row.stage==='COPY'&&valid(row))),
      imageSubmitted:uniqueTasks(day.filter(row=>row.kind==='SUBMIT'&&row.stage==='IMAGE'&&valid(row))),
      copyQa:summarizeQa(day).COPY.tasks,imageQa:summarizeQa(day).IMAGE.tasks,
      released:uniqueTasks(day.filter(row=>row.kind==='RELEASE'&&row.first&&valid(row))),COPY:qualityRate(day.filter(row=>row.stage==='COPY')),IMAGE:qualityRate(day.filter(row=>row.stage==='IMAGE'))});
  }
  const exclusions=new Map();
  for(const row of rows) if(row.exclusion && !isQaActivity(row)) exclusions.set(row.exclusion,(exclusions.get(row.exclusion)??0)+1);
  return {metricVersion:PERFORMANCE_VERSION,timezone:'Asia/Shanghai',asOf,
    range:{from:filters.range.from,to:filters.range.to},filters,summary:summarizeOperator(rows,present),people,trend,rows,
    dataQuality:{unknownIdentity:rows.filter(row=>row.accountId===null).length,
      excluded:[...exclusions].map(([reason,count])=>({reason,count})),
      timingSince:timeline.length ? timeline.reduce((min,row)=>row.at<min?row.at:min,timeline[0].at):null,
      historyNotice:'制作提交与质检操作分别归实际操作账号；内容通过率归提交人。缺失历史身份和时间不补造。'} };
}

export function performancePeoplePage(snapshot,filters) {
  const value=(person,key)=>({contributed:person.contributed,qa:person.qa.reviews,qaPending:person.qa.pending,submitted:person.submitted,released:person.released,copyRate:person.COPY.firstPass.rate,
    imageRate:person.IMAGE.firstPass.rate,returned:person.returned,pending:person.pending,
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
  const heading=['账号ID','姓名','账号','文案提交任务','图片提交任务','首次放行','文案通过','文案已审','图片通过','图片已审','退回任务','返修提交次数','文案周转中位毫秒','图片周转中位毫秒','当前待办','开始日期','结束日期','时区','报表时点','口径版本','交付确认任务','交付确认批次','文案抽中','文案已结批首次提交','图片抽中','图片已结批首次提交','文案时长缺失','图片时长缺失','批次退回影响','文案排除记录','图片排除记录'];
  heading.push('参与处理作业','文案质检次数','图片质检次数','质检作业','质检通过次数','质检退回次数','其中复检次数','批量退回次数','已知批量影响作业','旧批量影响项次','批量范围缺失次数','快捷直放次数','质检废弃次数','质检待办','质检阻塞','贡献视图');
  heading.push('文案首次标注条数','图片首次标注条数','文案返修条数','图片返修条数','文案质检条数','图片质检条数','文案首次返修通过','文案首次返修已检','图片首次返修通过','图片首次返修已检','当前建议改派','文案整体通过','文案整体已检','图片整体通过','图片整体已检');
  return '\uFEFF'+[heading,...snapshot.people.map(p=>[p.accountId,p.displayName,p.username,p.COPY.submitted,p.IMAGE.submitted,p.released,
    p.COPY.firstPass.passed,p.COPY.firstPass.decided,p.IMAGE.firstPass.passed,p.IMAGE.firstPass.decided,p.returned,p.reworkRounds,
    p.COPY.duration.medianMs,p.IMAGE.duration.medianMs,p.pending,snapshot.range.from,snapshot.range.to,snapshot.timezone,snapshot.asOf,snapshot.metricVersion,
    p.delivered,p.deliveredBatches,p.COPY.coverage.sampled,p.COPY.coverage.eligible,p.IMAGE.coverage.sampled,p.IMAGE.coverage.eligible,
    p.COPY.duration.missing,p.IMAGE.duration.missing,p.batchAffected,p.COPY.excluded,p.IMAGE.excluded,p.contributed,p.qa.COPY.reviews,p.qa.IMAGE.reviews,p.qa.tasks,p.qa.passed,p.qa.returned,p.qa.rechecks,p.qa.batchActions,p.qa.affectedTasks,p.qa.legacyAffectedCount,p.qa.unknownBatchScopes,p.qa.directPass,p.qa.discarded,p.qa.pending,p.qa.blocked,snapshot.filters.activity,
    p.COPY.firstSubmitted,p.IMAGE.firstSubmitted,p.COPY.reworked,p.IMAGE.reworked,p.qa.COPY.tasks,p.qa.IMAGE.tasks,
    p.COPY.firstRecheck.passed,p.COPY.firstRecheck.decided,p.IMAGE.firstRecheck.passed,p.IMAGE.firstRecheck.decided,p.reassignSuggested,
    p.COPY.overallPass.passed,p.COPY.overallPass.decided,p.IMAGE.overallPass.passed,p.IMAGE.overallPass.decided])]
    .map(row=>row.map(cell).join(',')).join('\r\n');
}
