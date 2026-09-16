// Web-only, read-only facts. Never retain execution snapshots or generated content here.
const DAY = 86_400_000;
export const STATE_GROUPS = Object.freeze({
  queued: ['COPY_QUEUED', 'IMAGE_QUEUED'], running: ['COPY_RUNNING', 'IMAGE_RUNNING'],
  copyReview: ['COPY_REVIEW_PENDING', 'COPY_QC_PENDING'], imageReview: ['MANUAL_ARCHIVE', 'IMAGE_QC_PENDING', 'IMAGE_REWORK_PENDING'],
  failed: ['COPY_FAILED', 'IMAGE_FAILED'], completed: ['REVIEWED'], cancelled: ['CANCELLED'],
});
const STATES = Object.values(STATE_GROUPS).flat();
const dateMs = (value) => value ? Date.parse(value) : NaN;
const textOrNull = value => typeof value === 'string' && value ? value.slice(0, 500) : null;
export const chinaDay = (milliseconds) => new Date(milliseconds + 8 * 3_600_000).toISOString().slice(0, 10);
const within = (value, range) => dateMs(value) >= range.startMs && dateMs(value) < range.endMs;

export function normalizeRange({ period = 'today', from, to } = {}, now = Date.now()) {
  if (!['today', '7d', '30d', 'custom'].includes(period)) throw new TypeError('时间范围无效');
  if (period !== 'custom') {
    to = chinaDay(now);
    from = chinaDay(now - (period === '30d' ? 29 : period === '7d' ? 6 : 0) * DAY);
  }
  for (const day of [from, to]) {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(day)
      || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) {
      throw new TypeError('请选择有效日期');
    }
  }
  const startMs = Date.parse(`${from}T00:00:00+08:00`);
  const endMs = Date.parse(`${to}T00:00:00+08:00`) + DAY;
  if (endMs <= startMs || endMs - startMs > 366 * DAY) throw new TypeError('日期范围应为 1–366 天');
  return { period, from, to, startMs, endMs };
}

export function compactTask(row) {
  if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || !STATES.includes(row.state)) {
    throw new TypeError('任务统计数据不完整');
  }
  if (!Object.hasOwn(row, 'createdByAccountId')
    || row.createdByAccountId !== null
      && (!Number.isSafeInteger(row.createdByAccountId) || row.createdByAccountId < 1)) {
    throw new TypeError('任务统计数据缺少稳定的创建者账号身份');
  }
  if (!Object.hasOwn(row, 'assignedToAccountId')
    || row.assignedToAccountId !== null
      && (!Number.isSafeInteger(row.assignedToAccountId) || row.assignedToAccountId < 1)) {
    throw new TypeError('任务统计数据缺少稳定的负责人账号身份');
  }
  return {
    id: row.id, state: row.state, query: String(row.query ?? '').slice(0, 500),
    createdByUserId: textOrNull(row.createdByUserId),
    createdByAccountId: row.createdByAccountId,
    assignedToUserId: textOrNull(row.assignedToUserId),
    assignedToAccountId: row.assignedToAccountId,
    assignedToDisplayName: textOrNull(row.assignedToDisplayName), assignedToRole: textOrNull(row.assignedToRole),
    assignedAt: textOrNull(row.assignedAt),
    createdByDisplayName: textOrNull(row.createdByDisplayName), createdByRole: textOrNull(row.createdByRole),
    createdAt: textOrNull(row.createdAt), updatedAt: textOrNull(row.updatedAt),
    imageReviewedAt: textOrNull(row.imageReviewedAt), lastActivityAt: textOrNull(row.lastActivityAt),
    currentImageRunId: textOrNull(row.currentImageRunId),
    currentCopyRevisionId: Number.isSafeInteger(row.currentCopyRevisionId) ? row.currentCopyRevisionId : null,
    copyQaReturned: row.mandatoryCopyQc === true && row.mandatoryCopyQcOrigin === 'QA_RETURN',
    retryExhausted: row.currentStage === 'IMAGE_RETRY_EXHAUSTED',
  };
}

export function compactDetail(detail) {
  if (!Array.isArray(detail?.executions) || !Array.isArray(detail?.imageRuns) || !Array.isArray(detail?.assets)) {
    throw new TypeError('执行统计字段不完整');
  }
  const rawAssessments = detail.humanQualityAssessments ?? [];
  if (!Array.isArray(rawAssessments)
    || [detail.executions, detail.imageRuns, detail.assets, rawAssessments].some(items => items.length > 10_000)) {
    throw new TypeError('任务执行明细超出统计读取上限');
  }
  const validId = value => typeof value === 'string' && value.length > 0 || Number.isSafeInteger(value) && value > 0;
  const scoreX10 = item => item.scoreX10 ?? (Number.isFinite(item.score) ? item.score * 10 : null);
  if (detail.executions.some(item => !item || !validId(item.id) || !['COPY', 'IMAGE'].includes(item.kind)
    || !['SUCCEEDED', 'FAILED', 'ABANDONED', 'RUNNING'].includes(item.status))
    || detail.assets.some(item => !item || !validId(item.id))
    || detail.imageRuns.some(item => !item || !validId(item.id))
    || rawAssessments.some(item => !item || !validId(item.id) || !['COPY', 'IMAGE'].includes(item.stage)
      || ![10, 20, 25, 30].includes(scoreX10(item)))) throw new TypeError('执行统计字段不完整');
  const assets = new Map(detail.assets.filter(asset => typeof asset.mediaType === 'string' && asset.mediaType.startsWith('image/'))
    .map(asset => [asset.id, { id: asset.id, runId: asset.imageRunId }]));
  const runs = new Map(detail.imageRuns.map(run => [run.executionId, run]));
  const selectedAssetIds = new Set(detail.imageRuns.flatMap((run) => {
    const images = Array.isArray(run?.result?.images) ? run.result.images : [];
    return images.map((image) => Number(image?.deliveryAssetId ?? image?.assetId))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
  }));
  return {
    executions: [...new Map(detail.executions.map(execution => {
      const run = runs.get(execution.id);
      return [execution.id, {
        id: execution.id, kind: execution.kind, status: execution.status,
        imageProductionChainId: textOrNull(execution.imageProductionChainId),
        startedAt: textOrNull(execution.startedAt), finishedAt: textOrNull(execution.finishedAt),
        simulated: run?.result?.simulation?.enabled === true,
      }];
    })).values()],
    images: [...selectedAssetIds].map((id) => assets.get(id)).filter(Boolean),
    simulatedRunIds: detail.imageRuns.filter(run => run.result?.simulation?.enabled === true).map(run => run.id),
    assessments: [...new Map(rawAssessments.map(assessment => [assessment.id, {
      id: assessment.id, stage: assessment.stage, scoreX10: scoreX10(assessment),
      ratingContext: textOrNull(assessment.ratingContext), createdAt: textOrNull(assessment.createdAt),
      copyRevisionId: Number.isSafeInteger(assessment.copyRevisionId) ? assessment.copyRevisionId : null,
      imageRunId: textOrNull(assessment.imageRunId),
    }])).values()],
  };
}

function emptyCounts() {
  return { total: 0, createdInPeriod: 0, completedInPeriod: 0, todayCreated: 0, todayCompleted: 0,
    completed: 0, pending: 0, cancelled: 0, anomalies: 0 };
}

function countTask(counts, task, range, today) {
  counts.total++;
  if (within(task.createdAt, range)) counts.createdInPeriod++;
  if (within(task.createdAt, today)) counts.todayCreated++;
  if (task.state === 'REVIEWED') {
    counts.completed++;
    if (within(task.imageReviewedAt, range)) counts.completedInPeriod++;
    if (within(task.imageReviewedAt, today)) counts.todayCompleted++;
  } else if (task.state === 'CANCELLED') counts.cancelled++;
  else counts.pending++;
  if (STATE_GROUPS.failed.includes(task.state) || (task.state === 'COPY_REVIEW_PENDING' && task.retryExhausted)) counts.anomalies++;
}

export function resolveWorkOwner(task) {
  if (task.assignedToUserId !== null || task.assignedToAccountId !== null) {
    const historical = task.assignedToAccountId === null && task.assignedToUserId !== null;
    return { accountId: task.assignedToAccountId, username: task.assignedToUserId,
      displayName: historical ? `历史账号（${task.assignedToUserId}）`
        : task.assignedToDisplayName || task.assignedToUserId || '待分配',
      role: historical ? null : task.assignedToRole, source: 'assignee',
      receivedAt: task.assignedAt || task.createdAt };
  }
  // Before assignment became mandatory, ordinary users owned the tasks they created.
  if (task.createdByRole === 'USER' && task.createdByUserId !== null) {
    return { accountId: task.createdByAccountId, username: task.createdByUserId,
      displayName: task.createdByDisplayName || task.createdByUserId,
      role: task.createdByRole, source: 'legacy-creator', receivedAt: task.createdAt };
  }
  return { accountId: null, username: null, displayName: '待分配', role: null,
    source: 'unassigned', receivedAt: task.createdAt };
}

function workOwnerKey(owner) {
  return owner.accountId === null
    ? owner.username === null ? 'unassigned' : `historical:${owner.username}`
    : `account:${owner.accountId}`;
}

function countPersonTask(counts, task, owner, range, today, now) {
  countTask(counts, task, range, today);
  counts.receivedInPeriod += within(owner.receivedAt, range) ? 1 : 0;
  counts.todayReceived += within(owner.receivedAt, today) ? 1 : 0;
  const last = dateMs(task.lastActivityAt || task.updatedAt || task.createdAt);
  if (!['REVIEWED', 'CANCELLED'].includes(task.state) && now - last >= DAY) counts.stale++;
  if (owner.source === 'legacy-creator') counts.legacyFallback++;
}

function daysInRange(range) {
  const days = [];
  for (let time = range.startMs; time < range.endMs; time += DAY) days.push(chinaDay(time));
  return days;
}

export function summarizeCounts(rawTasks, range, now = Date.now()) {
  const tasks = [...new Map(rawTasks.map(task => [task.id, task])).values()];
  const summary = emptyCounts();
  const today = normalizeRange({}, now);
  const states = Object.fromEntries(Object.keys(STATE_GROUPS).map(group => [group, 0]));
  let copyQaReturned = 0;
  let legacyOwnerFallback = 0;
  const people = new Map();
  const trend = new Map(daysInRange(range).map(date => [date, { date, created: 0, completed: 0 }]));
  const stale = [];
  let missingDates = 0;
  for (const task of tasks) {
    countTask(summary, task, range, today);
    if (task.copyQaReturned) copyQaReturned++;
    const owner = resolveWorkOwner(task);
    const key = workOwnerKey(owner);
    if (!people.has(key)) people.set(key, { ...emptyCounts(), receivedInPeriod: 0, todayReceived: 0,
      stale: 0, legacyFallback: 0, accountId: owner.accountId, username: owner.username,
      displayName: owner.displayName, role: owner.role });
    countPersonTask(people.get(key), task, owner, range, today, now);
    if (owner.source === 'legacy-creator') legacyOwnerFallback++;
    for (const [group, values] of Object.entries(STATE_GROUPS)) if (values.includes(task.state)) states[group]++;
    if (within(task.createdAt, range)) trend.get(chinaDay(dateMs(task.createdAt))).created++;
    if (task.state === 'REVIEWED' && within(task.imageReviewedAt, range)) {
      trend.get(chinaDay(dateMs(task.imageReviewedAt))).completed++;
    }
    if (!Number.isFinite(dateMs(task.createdAt))
      || (task.state === 'REVIEWED' && !Number.isFinite(dateMs(task.imageReviewedAt)))) missingDates++;
    const last = dateMs(task.lastActivityAt || task.updatedAt || task.createdAt);
    if (!['REVIEWED', 'CANCELLED'].includes(task.state) && now - last >= DAY) {
      stale.push({ id: task.id, query: task.query, username: owner.username, hours: Math.floor((now - last) / 3_600_000) });
    }
  }
  return { ...summary, states, copyQaReturned, legacyOwnerFallback,
    people: [...people.values()].sort((a, b) => b.completedInPeriod - a.completedInPeriod || b.receivedInPeriod - a.receivedInPeriod),
    trend: [...trend.values()], missingDates, staleCount: stale.length,
    stale: stale.sort((a, b) => b.hours - a.hours).slice(0, 20) };
}

function distribution(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (percent) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * percent) - 1)] : null;
  const middle = Math.floor(sorted.length / 2);
  return { samples: sorted.length, meanMs: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
    medianMs: sorted.length ? Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null,
    p90Ms: at(.9) };
}

function qualityStage(scores) {
  const threePoint = scores.filter(score => score === 30).length;
  const qualified = scores.filter(score => score > 20).length;
  return { samples: scores.length, threePoint, qualified,
    threePointRate: scores.length ? threePoint / scores.length : null,
    qualifiedRate: scores.length ? qualified / scores.length : null };
}

function firstAssessment(detail, stage) {
  const simulated = new Set(detail.simulatedRunIds);
  return detail.assessments.filter(assessment => assessment.stage === stage
    && assessment.ratingContext === (stage === 'COPY' ? 'ORIGINAL' : 'IMAGE')
    && Number.isFinite(dateMs(assessment.createdAt))
    && (stage !== 'IMAGE' || !simulated.has(assessment.imageRunId)))
    .toSorted((a, b) => dateMs(a.createdAt) - dateMs(b.createdAt)
      || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))[0] ?? null;
}

function intervalUnionDuration(executions) {
  const intervals = executions.map((execution) => [dateMs(execution.startedAt), dateMs(execution.finishedAt)])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
    .toSorted((left, right) => left[0] - right[0] || left[1] - right[1]);
  if (!intervals.length) return null;
  let total = 0;
  let [start, end] = intervals[0];
  for (const [nextStart, nextEnd] of intervals.slice(1)) {
    if (nextStart <= end) {
      end = Math.max(end, nextEnd);
    } else {
      total += end - start;
      [start, end] = [nextStart, nextEnd];
    }
  }
  return total + end - start;
}

export function summarizeEfficiency(tasks, detailById, range) {
  const groups = { COPY: { values: [], failed: 0, succeeded: 0, abandoned: 0, invalid: 0 },
    IMAGE: { values: [], failed: 0, succeeded: 0, abandoned: 0, invalid: 0 } };
  const dayValues = new Map(daysInRange(range).map(date => [date, { date, copy: [], image: [] }]));
  const delivery = [], copyScores = [], imageScores = [];
  const peopleQuality = new Map();
  let effectiveImages = 0, simulated = 0, executionTasks = 0, repeatedTasks = 0;
  for (const task of tasks) {
    if (task.state === 'REVIEWED' && within(task.imageReviewedAt, range)) {
      const elapsed = dateMs(task.imageReviewedAt) - dateMs(task.createdAt);
      if (Number.isFinite(elapsed) && elapsed >= 0) delivery.push(elapsed);
    }
    const detail = detailById.get(task.id);
    if (!detail) continue;
    const firstCopyAssessment = firstAssessment(detail, 'COPY');
    const firstImageAssessment = firstAssessment(detail, 'IMAGE');
    const periodAssessments = [];
    if (firstCopyAssessment && within(firstCopyAssessment.createdAt, range)) {
      copyScores.push(firstCopyAssessment.scoreX10);
      periodAssessments.push(firstCopyAssessment);
    }
    if (firstImageAssessment && within(firstImageAssessment.createdAt, range)) {
      imageScores.push(firstImageAssessment.scoreX10);
      periodAssessments.push(firstImageAssessment);
    }
    if (periodAssessments.length) {
      const owner = resolveWorkOwner(task);
      const key = workOwnerKey(owner);
      if (!peopleQuality.has(key)) peopleQuality.set(key, {
        accountId: owner.accountId, username: owner.username, samples: 0, qualified: 0,
      });
      const quality = peopleQuality.get(key);
      quality.samples += periodAssessments.length;
      quality.qualified += periodAssessments.filter(assessment => assessment.scoreX10 > 20).length;
    }
    if (task.state === 'REVIEWED' && task.currentImageRunId && within(task.imageReviewedAt, range)
      && !detail.simulatedRunIds.includes(task.currentImageRunId)) {
      effectiveImages += detail.images.filter(asset => asset.runId === task.currentImageRunId).length;
    }
    let hasFinishedInRange = false;
    const attempts = { COPY: 0, IMAGE: 0 };
    const imageChains = new Map();
    for (const execution of detail.executions) {
      const group = groups[execution.kind];
      if (!group) continue;
      if (!execution.simulated) attempts[execution.kind]++;
      if (execution.kind === 'IMAGE' && !execution.simulated) {
        const chainId = execution.imageProductionChainId || `legacy:${execution.id}`;
        if (!imageChains.has(chainId)) imageChains.set(chainId, []);
        imageChains.get(chainId).push(execution);
      }
      if (!within(execution.finishedAt, range)) continue;
      if (execution.simulated) { simulated++; continue; }
      if (execution.status === 'ABANDONED') { group.abandoned++; continue; }
      if (!['SUCCEEDED', 'FAILED'].includes(execution.status)) continue;
      hasFinishedInRange = true;
      if (execution.status === 'FAILED') { group.failed++; continue; }
      group.succeeded++;
      const elapsed = dateMs(execution.finishedAt) - dateMs(execution.startedAt);
      if (!Number.isFinite(elapsed) || elapsed < 0) { group.invalid++; continue; }
      if (execution.kind === 'COPY') {
        group.values.push(elapsed);
        dayValues.get(chinaDay(dateMs(execution.finishedAt))).copy.push(elapsed);
      }
    }
    for (const executions of imageChains.values()) {
      const completion = executions.filter((execution) => execution.status === 'SUCCEEDED'
        && within(execution.finishedAt, range))
        .toSorted((left, right) => dateMs(right.finishedAt) - dateMs(left.finishedAt))[0];
      if (!completion) continue;
      if (!Number.isFinite(dateMs(completion.startedAt))
          || dateMs(completion.finishedAt) < dateMs(completion.startedAt)) continue;
      const elapsed = intervalUnionDuration(executions.filter((execution) =>
        ['SUCCEEDED', 'FAILED', 'ABANDONED'].includes(execution.status)));
      if (elapsed === null) continue;
      groups.IMAGE.values.push(elapsed);
      dayValues.get(chinaDay(dateMs(completion.finishedAt))).image.push(elapsed);
    }
    if (hasFinishedInRange) {
      executionTasks++;
      if (attempts.COPY > 1 || attempts.IMAGE > 1) repeatedTasks++;
    }
  }
  const result = group => ({ ...distribution(group.values), failed: group.failed, succeeded: group.succeeded,
    abandoned: group.abandoned, invalid: group.invalid,
    failureRate: group.succeeded + group.failed ? group.failed / (group.succeeded + group.failed) : null });
  return { copy: result(groups.COPY), image: result(groups.IMAGE), delivery: distribution(delivery), effectiveImages,
    simulated, executionTasks, repeatedTasks, repeatRate: executionTasks ? repeatedTasks / executionTasks : null,
    quality: { copy: qualityStage(copyScores), image: qualityStage(imageScores) },
    peopleQuality: [...peopleQuality.values()].map(person => ({ ...person,
      passRate: person.samples ? person.qualified / person.samples : null })),
    trend: [...dayValues.values()].map(day => ({ date: day.date, copyMs: distribution(day.copy).meanMs, imageMs: distribution(day.image).meanMs })) };
}
