import { chinaDay, normalizeRange } from './web-statistics/summary.mjs';

export const PERSONAL_WORK_FILTERS = Object.freeze([
  ['ALL', '全部'], ['actionable', '我需处理'], ['review', '待审核'], ['rework', '待返修'],
  ['production', '生产中'], ['qa', '待质检'], ['anomaly', '执行异常'], ['ready', '可交付'],
]);
export const PERSONAL_WORK_CATEGORIES = Object.freeze([
  ...PERSONAL_WORK_FILTERS.map(([key]) => key), 'copyInitial', 'imageInitial', 'copyRework', 'imageRework', 'bothRework',
  'previews', 'planRunning', 'repairRunning', 'backgroundFailed', 'recheck', 'longWaiting', 'completed', 'cancelled',
]);
const LEGACY = { personalReview: 'review', personalProduction: 'production', failed: 'anomaly', copyQaReturned: 'copyRework',
  copyReview: 'COPY_REVIEW_PENDING', imageReview: 'MANUAL_ARCHIVE', queued: 'queued', running: 'running' };
const STATES = ['COPY_QUEUED','COPY_RUNNING','COPY_REVIEW_PENDING','COPY_QC_PENDING','COPY_FAILED','IMAGE_QUEUED',
  'IMAGE_RUNNING','IMAGE_FAILED','MANUAL_ARCHIVE','IMAGE_QC_PENDING','IMAGE_REWORK_PENDING','REVIEWED','CANCELLED'];
const one = value => Array.isArray(value) ? value[0] : value;
function choice(value, values, fallback) { return values.includes(one(value)) ? one(value) : fallback; }
function integer(value, fallback, min, max) { const n = Number(one(value)); return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback; }

export function normalizePersonalFilters(input = {}, now = Date.now()) {
  const mode = choice(input.mode, ['CURRENT','COMPLETED','RETURNS','REWORK','QUALITY'], 'CURRENT');
  const rawCategory = one(input.category) ?? one(input.state);
  const category = LEGACY[rawCategory] ?? rawCategory;
  const period = choice(input.period, ['today','7d','30d','custom'], 'today');
  const range = normalizeRange({ period, from: one(input.from), to: one(input.to) }, now);
  return { mode, category: [...PERSONAL_WORK_CATEGORIES, ...STATES, 'queued', 'running'].includes(category) ? category : 'ALL',
    personalScope: choice(input.personalScope, ['ALL','ASSIGNED','CREATED'], 'ASSIGNED'),
    query: String(one(input.query) ?? '').trim().slice(0, 500),
    queryPackageName: String(one(input.queryPackageName) ?? '').trim().slice(0, 200),
    priorityMode: choice(input.priorityMode, ['SYSTEM','HIGHEST','HIGH','NORMAL','DEFER','PAUSE'], ''),
    reworkType: choice(input.reworkType, ['COPY','IMAGE','BOTH'], ''),
    reworkProgress: choice(input.reworkProgress, ['EDIT','PROCESSING','CONFIRM'], ''),
    reworkSource: choice(input.reworkSource, ['COPY_QA','IMAGE_QA','FINAL_REWORK'], ''),
    longWaiting: [true,'true','1'].includes(one(input.longWaiting)), repeated: [true,'true','1'].includes(one(input.repeated)),
    qualityFirst: [true,'true','1'].includes(one(input.qualityFirst)),
    qualityRecheck: [true,'true','1'].includes(one(input.qualityRecheck)),
    stage: choice(input.stage, ['COPY','IMAGE'], ''),
    sort: choice(input.sort, ['priority:desc','createdAt:desc','createdAt:asc','id:desc','id:asc','waiting:desc'], 'priority:desc'),
    deduplicateQuery: [true,'true','1'].includes(one(input.deduplicateQuery)),
    page: integer(input.page, 1, 1, 1_000_000), pageSize: integer(input.pageSize, 20, 1, 100),
    taskId: integer(input.taskId, null, 1, Number.MAX_SAFE_INTEGER),
    createdFrom: one(input.createdFrom) || '', createdTo: one(input.createdTo) || '',
    range: { ...range, period },
  };
}

export function personalListHref(filters = {}) {
  const search = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, String(value)]));
  return `/workbench/personal${search.size ? `?${search}` : ''}`;
}

export function classifyPersonalTask(task, now = Date.now()) {
  const edits = task.imageEdits ?? { queued: 0, running: 0, ready: 0, failed: 0 };
  const planRunning = ['QUEUED','RUNNING'].includes(task.planStatus);
  const planReady = task.planStatus === 'SUCCEEDED';
  const repairRunning = edits.queued + edits.running > 0;
  const active = !['REVIEWED','CANCELLED'].includes(task.state);
  const exhausted = task.currentStage === 'IMAGE_RETRY_EXHAUSTED';
  const copyRework = task.state === 'COPY_REVIEW_PENDING' && !exhausted
    && ['QA_RETURN','FINAL_REWORK'].includes(task.copyReworkOrigin);
  const imageRework = task.state === 'IMAGE_REWORK_PENDING'
    || task.state === 'MANUAL_ARCHIVE' && task.mandatoryImageQc === true;
  const rework = copyRework || imageRework;
  const reworkType = rework ? task.reworkTarget === 'BOTH' ? 'BOTH' : copyRework ? 'COPY' : 'IMAGE' : null;
  const reworkProgress = rework ? planRunning || repairRunning ? 'PROCESSING' : edits.ready || planReady ? 'CONFIRM' : 'EDIT' : null;
  const copyInitial = task.state === 'COPY_REVIEW_PENDING' && !rework && !exhausted;
  const imageInitial = task.state === 'MANUAL_ARCHIVE' && !rework;
  const anomaly = ['COPY_FAILED','IMAGE_FAILED'].includes(task.state) || exhausted;
  const backgroundFailed = active && (task.planStatus === 'FAILED' || edits.failed > 0);
  const previews = active && (edits.ready > 0 || planReady);
  const needsHuman = (copyInitial || imageInitial || rework || anomaly || backgroundFailed || previews)
    && (!(planRunning || repairRunning) || previews || backgroundFailed);
  const waitingSince = previews ? (planReady ? task.planReadyAt : task.previewReadyAt) ?? task.queueEnteredAt : task.queueEnteredAt;
  const waitingHours = needsHuman && Number.isFinite(Date.parse(waitingSince))
    ? Math.max(0, (now - Date.parse(waitingSince)) / 3_600_000) : null;
  const categories = ['ALL'];
  const flags = { actionable: task.isAssigned && needsHuman, review: copyInitial || imageInitial, copyInitial, imageInitial,
    rework, copyRework: reworkType === 'COPY', imageRework: reworkType === 'IMAGE', bothRework: reworkType === 'BOTH',
    production: ['COPY_QUEUED','COPY_RUNNING','IMAGE_QUEUED','IMAGE_RUNNING'].includes(task.state),
    qa: ['COPY_QC_PENDING','IMAGE_QC_PENDING'].includes(task.state), anomaly, previews,
    planRunning: active && planRunning, repairRunning: active && repairRunning, backgroundFailed,
    recheck: task.state === 'COPY_QC_PENDING' && task.mandatoryCopyQc === true
      || task.state === 'IMAGE_QC_PENDING' && task.mandatoryImageQc === true,
    ready: task.state === 'REVIEWED' && task.deliveryReady === true,
    completed: task.state === 'REVIEWED', cancelled: task.state === 'CANCELLED', longWaiting: waitingHours !== null && waitingHours >= 24 };
  for (const [key, value] of Object.entries(flags)) if (value) categories.push(key);
  return { categories, reworkType, reworkProgress, waitingSince: needsHuman ? waitingSince : null, waitingHours,
    reworkSource: rework ? task.reworkSource ?? (imageRework ? 'IMAGE_QA' : task.copyReworkOrigin === 'FINAL_REWORK' ? 'FINAL_REWORK' : 'COPY_QA') : null,
    returnedAt: rework ? task.returnedAt : null, returnNote: rework ? task.returnNote : null,
    returnReasons: rework && Array.isArray(task.returnReasons) ? task.returnReasons : [],
    reworkCount: task.reworkCount ?? 0, imageEdits: edits, planStatus: active ? task.planStatus : null };
}

function relation(task, scope) { return scope === 'ASSIGNED' ? task.isAssigned : scope === 'CREATED' ? task.isCreated : task.isAssigned || task.isCreated; }
function categoryMatches(task, category) {
  if (category === 'queued') return ['COPY_QUEUED','IMAGE_QUEUED'].includes(task.state);
  if (category === 'running') return ['COPY_RUNNING','IMAGE_RUNNING'].includes(task.state);
  return task.personalWork.categories.includes(category) || task.state === category;
}
function baseMatches(task, filters) {
  const search = filters.query.replace(/^#/u, '').toLocaleLowerCase('zh-CN');
  if (search && !(String(task.id) === search || !/^\d+$/u.test(search) && task.query.toLocaleLowerCase('zh-CN').includes(search))) return false;
  if (filters.queryPackageName && !(task.sourceQueryPackageName ?? '').toLocaleLowerCase('zh-CN').includes(filters.queryPackageName.toLocaleLowerCase('zh-CN'))) return false;
  if (filters.priorityMode && task.priorityMode !== filters.priorityMode) return false;
  const work = task.personalWork;
  if (filters.reworkType && work.reworkType !== filters.reworkType) return false;
  if (filters.reworkProgress && work.reworkProgress !== filters.reworkProgress) return false;
  if (filters.reworkSource && work.reworkSource !== filters.reworkSource) return false;
  if (filters.longWaiting && !work.categories.includes('longWaiting')) return false;
  if (filters.repeated && (filters.mode === 'CURRENT' ? work.reworkCount < 2 : !task.history.some(event => event.kind === 'RETURN' && event.round >= 2))) return false;
  const createdDay = Number.isFinite(Date.parse(task.createdAt)) ? chinaDay(Date.parse(task.createdAt)) : null;
  if (filters.mode === 'CURRENT' && filters.createdFrom && (!createdDay || createdDay < filters.createdFrom)) return false;
  if (filters.mode === 'CURRENT' && filters.createdTo && (!createdDay || createdDay > filters.createdTo)) return false;
  return true;
}
function deduplicate(tasks, enabled) {
  if (!enabled) return tasks;
  const seen = new Set();
  return [...tasks].sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id-a.id).filter(task => {
    const key = task.query.trim().replace(/\s+/gu,' ').toLocaleLowerCase('zh-CN');
    if (seen.has(key)) return false; seen.add(key); return true;
  });
}
const inRange = (date, range) => Date.parse(date) >= range.startMs && Date.parse(date) < range.endMs;

export function selectPersonalTasks(facts, events, filters, now = Date.now()) {
  const history = new Map();
  for (const event of events) {
    if (!inRange(event.at, filters.range) || filters.stage && event.stage !== filters.stage) continue;
    if (filters.mode === 'QUALITY' && filters.qualityFirst && !event.first) continue;
    if (filters.mode === 'QUALITY' && filters.qualityRecheck && !event.firstRecheck) continue;
    if (filters.mode === 'COMPLETED' && event.kind !== 'COMPLETE'
      || filters.mode === 'REWORK' && !(event.kind === 'COMPLETE' && event.rework)
      || filters.mode === 'RETURNS' && event.kind !== 'RETURN'
      || filters.mode === 'QUALITY' && event.kind !== 'QUALITY') continue;
    const prior = history.get(event.taskId) ?? [];
    history.set(event.taskId, [...prior, event]);
  }
  const historicalFacts=[...facts];
  if(filters.mode!=='CURRENT') {
    const available=new Set(facts.map(task=>task.id));
    for(const id of history.keys()) if(!available.has(id)) historicalFacts.push({id,query:`历史内容 #${id}`,state:'HISTORY_ONLY',
      createdAt:null,isAssigned:false,isCreated:false,canOpen:false});
  }
  const candidates = historicalFacts.map(task => ({ ...task, personalWork: classifyPersonalTask(task, now), history: history.get(task.id) ?? [] }))
    .filter(task => filters.mode === 'CURRENT' ? relation(task, filters.personalScope) : history.has(task.id))
    .filter(task => baseMatches(task, filters));
  const counts = Object.fromEntries(PERSONAL_WORK_CATEGORIES.map(category => [category,
    deduplicate(candidates.filter(task => categoryMatches(task, category)), filters.deduplicateQuery).length]));
  const matching = deduplicate(candidates.filter(task => categoryMatches(task, filters.category)), filters.deduplicateQuery);
  const newestEvent = task => Math.max(0, ...task.history.map(event => Date.parse(event.at)));
  matching.sort((a,b) => {
    if (filters.mode !== 'CURRENT') return newestEvent(b)-newestEvent(a) || b.id-a.id;
    if (filters.sort === 'waiting:desc' || filters.category === 'rework' && filters.sort === 'priority:desc') return (b.personalWork.waitingHours ?? -1)-(a.personalWork.waitingHours ?? -1) || a.id-b.id;
    if (filters.sort.startsWith('id:')) return (filters.sort.endsWith('asc') ? 1 : -1)*(a.id-b.id);
    if (filters.sort.startsWith('createdAt:')) return (filters.sort.endsWith('asc') ? 1 : -1)*(Date.parse(a.createdAt)-Date.parse(b.createdAt) || a.id-b.id);
    return Number(a.priorityMode === 'PAUSE')-Number(b.priorityMode === 'PAUSE') || Date.parse(a.prioritySortAt)-Date.parse(b.prioritySortAt) || a.id-b.id;
  });
  const total = matching.length;
  const page = Math.min(filters.page, Math.max(1, Math.ceil(total / filters.pageSize)));
  const offset = (page-1)*filters.pageSize;
  return { items: matching.slice(offset, offset+filters.pageSize), total, limit: filters.pageSize, offset, counts };
}

export function summarizePersonalWorkspace(facts, events, batches, filters, now = Date.now()) {
  const current = facts.filter(task => relation(task, filters.personalScope)).map(task => ({ ...task, personalWork: classifyPersonalTask(task, now) }));
  const counts = Object.fromEntries(PERSONAL_WORK_CATEGORIES.map(category => [category, current.filter(task => categoryMatches(task, category)).length]));
  const periodEvents = events.filter(event => inRange(event.at, filters.range));
  const completed = periodEvents.filter(event => event.kind === 'COMPLETE');
  const returned = periodEvents.filter(event => event.kind === 'RETURN');
  const reworked = completed.filter(event => event.rework);
  const countTasks = items => new Set(items.map(event => event.taskId)).size;
  const trend = [];
  for (let time = filters.range.startMs; time < filters.range.endMs; time += 86_400_000) {
    const day = chinaDay(time), daily = periodEvents.filter(event => chinaDay(Date.parse(event.at)) === day);
    trend.push({ date: day, copy: countTasks(daily.filter(event => event.kind === 'COMPLETE' && event.stage === 'COPY')),
      image: countTasks(daily.filter(event => event.kind === 'COMPLETE' && event.stage === 'IMAGE')),
      returned: countTasks(daily.filter(event => event.kind === 'RETURN')),
      reworked: countTasks(daily.filter(event => event.kind === 'COMPLETE' && event.rework)) });
  }
  const quality = Object.fromEntries(['COPY','IMAGE'].map(stage => {
    const samples = periodEvents.filter(event => event.kind === 'QUALITY' && event.stage === stage && event.first === true);
    const passed = samples.filter(event => event.passed).length;
    return [stage, { samples: samples.length, passed, rate: samples.length ? passed/samples.length : null }];
  }));
  const annotation=Object.fromEntries(['COPY','IMAGE'].map(stage=>{
    const submitted=completed.filter(event=>event.stage===stage),rechecks=periodEvents.filter(event=>event.stage===stage&&event.kind==='QUALITY'&&event.firstRecheck===true);
    const passed=rechecks.filter(event=>event.passed).length;
    return [stage,{firstSubmitted:countTasks(submitted.filter(event=>event.firstSubmission)),reworked:countTasks(submitted.filter(event=>event.rework)),
      submissions:submitted.length,firstRecheck:{passed,samples:rechecks.length,rate:rechecks.length?passed/rechecks.length:null}}];
  }));
  const reasons = new Map();
  for (const event of returned) for (const reason of new Set(event.reasons ?? [])) reasons.set(reason,(reasons.get(reason) ?? 0)+1);
  const durations = reworked.map(event => Date.parse(event.at)-Date.parse(event.returnedAt)).filter(value => Number.isFinite(value) && value >= 0).sort((a,b) => a-b);
  const delivered = batches.filter(batch => batch.status === 'DELIVERED' && inRange(batch.deliveredAt, filters.range));
  return { updatedAt: new Date(now).toISOString(), scope: filters.personalScope, range: { from: filters.range.from, to: filters.range.to },
    counts, annotation, rework: { copy: counts.copyRework, image: counts.imageRework, both: counts.bothRework,
      edit: current.filter(task => task.personalWork.reworkProgress === 'EDIT').length,
      processing: current.filter(task => task.personalWork.reworkProgress === 'PROCESSING').length,
      confirm: current.filter(task => task.personalWork.reworkProgress === 'CONFIRM').length,
      longWaiting: current.filter(task => task.personalWork.categories.includes('rework') && task.personalWork.categories.includes('longWaiting')).length,
      longestHours: Math.max(0,...current.filter(task => task.personalWork.categories.includes('rework')).map(task => task.personalWork.waitingHours ?? 0)) },
    background: { plan: counts.planRunning, repair: counts.repairRunning, previews: counts.previews, failed: counts.backgroundFailed,
      imageRequests: current.reduce((sum, task) => sum+task.personalWork.imageEdits.queued+task.personalWork.imageEdits.running,0) },
    period: { completed: countTasks(completed), copy: countTasks(completed.filter(event => event.stage === 'COPY')),
      image: countTasks(completed.filter(event => event.stage === 'IMAGE')), returned: countTasks(returned), reworked: countTasks(reworked), reworkRounds: reworked.length,
      deliveredBatches: new Set(delivered.map((batch,index) => batch.batchId ?? `legacy-${index}`)).size,
      deliveredTasks: new Set(delivered.flatMap(batch => batch.taskIds)).size,
      confirmedByMeTasks: new Set(delivered.filter(batch => batch.confirmedByMe).flatMap(batch => batch.taskIds)).size },
    pendingDeliveryBatches: new Set(batches.filter(batch => batch.status === 'DOWNLOADED').map((batch,index) => batch.batchId ?? `legacy-${index}`)).size, trend, quality,
    repeatReworkTasks: countTasks(returned.filter(event => event.round >= 2)),
    reasons: [...reasons].sort((a,b) => b[1]-a[1]).slice(0,8).map(([code,count]) => ({ code,count })),
    reworkDuration: { samples: durations.length, medianMs: durations.length ? (durations[Math.floor((durations.length-1)/2)] + durations[Math.floor(durations.length/2)])/2 : null },
    missingDates: current.filter(task => task.personalWork.categories.includes('actionable') && task.personalWork.waitingHours === null).length,
    historyNotice: '完成与质量数据按事件中的账号身份统计；缺少身份或时间的历史记录不纳入，已删除作业的旧事件可能不可恢复。' };
}
