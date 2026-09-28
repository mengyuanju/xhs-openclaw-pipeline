'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Boxes, ChevronDown, ChevronRight, PackageCheck, PackageOpen, RefreshCw, Search, Settings2, Trash2, Truck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { apiRequest } from '../../components/api-client';
import styles from './task-data-report.module.css';

const REPORT_API = '/api/control-plane/v1/admin/task-data-report/query';
const EXPORT_API = '/api/control-plane/v1/admin/task-data-report/export';
const SAVED_API = '/api/control-plane/v1/admin/task-data-report/saved-queries';
const USERS_API = '/api/control-plane/v1/users';

type TimeField = 'FIRST_COPY_REVIEW_ACTION';
type TimeSelection = { field: TimeField; mode: 'ABSOLUTE'; from: string; to: string };

const PEOPLE_FIELDS = [
  ['ANNOTATOR', '标注人', '匹配任务历任标注人，包含驳回后的改派'],
  ['COPY_QA_REVIEWER', '文案质检人', '匹配实际作出文案质检结论的人'],
  ['IMAGE_QA_REVIEWER', '图片质检人', '匹配实际作出图片质检结论的人'],
] as const;
type PeopleField = (typeof PEOPLE_FIELDS)[number][0];
type ConditionField = PeopleField | 'TASK_ID_OR_NAME' | 'STATE' | 'REJECTION_COUNT' | 'REASSIGNMENT_COUNT';
type Condition = { field: ConditionField; op: 'EQ' | 'CONTAINS' | 'GTE' | 'LTE'; value: string };
type QueryConfig = {
  time: TimeSelection;
  match: 'ALL' | 'ANY';
  conditions: Condition[];
  sort: 'FIRST_COPY_REVIEW_ACTION' | 'CREATED_AT' | 'TASK_ID';
  order: 'ASC' | 'DESC';
  pageSize: number;
};
type Account = { id: number; username: string; displayName?: string; status?: string; role: 'ADMIN' | 'REVIEWER' | 'USER'; copyReviewEnabled?: boolean; copyQcEnabled?: boolean; imageQcEnabled?: boolean };
type Person = { accountId?: number | null; username?: string | null; displayName?: string | null; assignedAt?: string | null; source?: string | null };
type TaskRow = {
  taskId: number; taskName: string; state: string; createdAt: string | null;
  productionBatchId?: number | null; queryPackageName?: string | null;
  firstManualCopyAssignmentAt: string | null; firstCopyAssignmentAt: string | null; firstCopyReviewAt: string | null; reportAt: string | null;
  annotationPeople: Person[]; currentAnnotator: Person | null;
  copyQaPeople: Person[]; imageQaPeople: Person[];
  lastCopyReviewer: Person | null; lastImageReviewer: Person | null;
  copyStatus: string; imageStatus: string; copyQaStatus: string | null; imageQaStatus: string | null;
  copyRejectionCount: number; imageRejectionCount: number; rejectionCount: number; reassignmentCount: number;
  copyReviewPassedAt: string | null; copyQaReleasedAt: string | null; copyQaHumanPassedAt: string | null; copyQaReleaseMode: string | null;
  imageReviewPassedAt: string | null; imageQaReleasedAt: string | null; imageQaHumanPassedAt: string | null; imageQaReleaseMode: string | null;
  deliveredAt: string | null; dataQuality?: Record<string, unknown>;
};
type ReportResponse = {
  overview?: { unpacked: number; packed: number; delivered: number };
  summary: { total: number; reviewPending: number; copyReviewPending: number; imageReviewPending: number; qaPending: number; copyQaPending: number; imageQaPending: number; byState: Record<string, number>; copyQaPassed: number; copyQaFirstPassed: number; imageQaPassed: number; discarded: number; packingDelivery: number };
  items: TaskRow[]; total: number; page: number; pageSize: number; asOf: string;
  dataQuality?: { legacyAssignmentCount?: number; missingFirstManualAssignmentCount?: number };
};
type TimelineEvent = { at: string; kind: string; stage: 'COPY' | 'IMAGE' | null; actor: string | null; details: Record<string, unknown> };
type TaskDetailResponse = { item: TaskRow; events: TimelineEvent[]; eventsTruncated: boolean; asOf: string };
type SavedQuery = { id: number; name: string; query: QueryConfig; isDefault: boolean; createdAt: string; updatedAt: string };

const STATE_OPTIONS = [
  ['COPY_QUEUED', '待文案执行'], ['COPY_RUNNING', '文案生成中'], ['COPY_REVIEW_PENDING', '待文案审核'],
  ['COPY_QC_PENDING', '待文案质检'], ['PENDING_SECOND_ASSIGNMENT', '待二次分配'], ['COPY_FAILED', '文案生成失败'],
  ['IMAGE_QUEUED', '待生图'], ['IMAGE_RUNNING', '生图中'], ['MANUAL_ARCHIVE', '待图片初审'],
  ['IMAGE_QC_PENDING', '待图片质检'], ['IMAGE_REWORK_PENDING', '图片质检打回'], ['IMAGE_FAILED', '图片生成失败'],
  ['REVIEWED', '交付池'], ['CANCELLED', '已废弃'],
] as const;
const STATE_LABELS = Object.fromEntries(STATE_OPTIONS);
const HIDDEN_FILTER_STATES = new Set(['COPY_QUEUED', 'COPY_RUNNING', 'COPY_FAILED', 'IMAGE_FAILED']);
const FILTER_STATE_OPTIONS = STATE_OPTIONS.filter(([value]) => !HIDDEN_FILTER_STATES.has(value));
const FILTER_STATES = new Set<string>(FILTER_STATE_OPTIONS.map(([value]) => value));
const METRIC_STORAGE_KEY = 'task-data-report:visible-metrics:v1';
const METRIC_OPTIONS = [
  { id: 'total', label: '任务总数' },
  { id: 'copyReviewPending', label: '文案待审核数量' },
  { id: 'imageReviewPending', label: '图片待审核数量' },
  { id: 'copyQaPending', label: '文案待质检数量' },
  { id: 'imageQaPending', label: '图片待质检数量' },
  { id: 'imageQueued', label: '待生图数量' },
  { id: 'copyQaPassed', label: '文案质检通过数量' },
  { id: 'imageQaPassed', label: '图片质检通过数量' },
  { id: 'discarded', label: '废弃数量' },
  { id: 'packingDelivery', label: '打包交付数量' },
] as const;
type MetricId = (typeof METRIC_OPTIONS)[number]['id'];
const DEFAULT_METRIC_IDS: MetricId[] = ['total', 'copyQaPassed', 'discarded', 'packingDelivery'];

const EMPTY_CONFIG: QueryConfig = {
  time: { field: 'FIRST_COPY_REVIEW_ACTION', mode: 'ABSOLUTE', ...relativeRange(1) },
  match: 'ALL', conditions: [], sort: 'FIRST_COPY_REVIEW_ACTION', order: 'DESC', pageSize: 20,
};

function chinaToday() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function relativeRange(days: number) {
  const to = chinaToday();
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

function numericCondition(field: ConditionField) {
  return PEOPLE_FIELDS.some(([candidate]) => candidate === field) || ['REJECTION_COUNT', 'REASSIGNMENT_COUNT'].includes(field);
}

function serializedConditions(conditions: Condition[]) {
  return conditions.filter(condition => String(condition.value).trim()).map(condition => ({
    ...condition, value: numericCondition(condition.field) ? Number(condition.value) : String(condition.value).trim(),
  }));
}

function queryBody(config: QueryConfig, page: number) {
  return { time: { field: 'FIRST_COPY_REVIEW_ACTION', from: config.time.from, to: config.time.to }, match: 'ALL',
    conditions: serializedConditions(config.conditions),
    page, pageSize: config.pageSize, sort: config.sort, order: config.order };
}

function timeText(value: string | null | undefined) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function personText(person: Person | null | undefined) {
  if (!person) return '—';
  const name = person.displayName || person.username || (person.accountId ? `账号 #${person.accountId}` : '未知人员');
  return person.username && name !== person.username ? `${name}（${person.username}）` : name;
}

function peopleText(people: Person[] | null | undefined) {
  return people?.length ? people.map(personText).join(' → ') : '—';
}

function cleanConfig(value: QueryConfig): QueryConfig {
  // Saved configurations come from the server; keep a fresh copy for form edits.
  const savedTime = value?.time as TimeSelection | { mode: 'RELATIVE'; days: number };
  const range = value === EMPTY_CONFIG ? relativeRange(1) : savedTime && 'from' in savedTime && 'to' in savedTime
    ? { from: savedTime.from, to: savedTime.to }
    : relativeRange(savedTime && 'days' in savedTime ? savedTime.days : 1);
  const allowed = new Set<ConditionField>(['TASK_ID_OR_NAME', 'ANNOTATOR', 'STATE',
    'REJECTION_COUNT', 'REASSIGNMENT_COUNT', 'COPY_QA_REVIEWER', 'IMAGE_QA_REVIEWER']);
  const seen = new Set<ConditionField>();
  const conditions = Array.isArray(value?.conditions) ? value.conditions.filter(condition => {
    if (!allowed.has(condition.field) || seen.has(condition.field)) return false;
    if (condition.field === 'STATE' && !FILTER_STATES.has(String(condition.value))) return false;
    seen.add(condition.field);
    return true;
  }).map(condition => ({
    field: condition.field,
    op: condition.field === 'TASK_ID_OR_NAME' ? 'CONTAINS' as const
      : condition.field === 'REASSIGNMENT_COUNT' ? 'GTE' as const : 'EQ' as const,
    value: String(condition.value ?? ''),
  })) : [];
  return { ...EMPTY_CONFIG, time: { field: 'FIRST_COPY_REVIEW_ACTION', mode: 'ABSOLUTE', ...range },
    match: 'ALL', conditions };
}

const EVENT_LABELS: Record<string, string> = {
  TASK_CREATED: '任务创建', ASSIGNMENT: '文案分配 / 改派',
  COPY_REVIEW_DECISION: '文案审核打回 / 废弃', COPY_REVIEW_PASSED: '文案审核通过',
  COPY_QA_HUMAN_PASSED: '文案抽检通过', COPY_QA_RETURNED: '文案质检打回', COPY_QA_BATCH_RELEASED: '文案免检放行',
  IMAGE_REVIEW_DECISION: '图片审核打回 / 废弃', IMAGE_REVIEW_PASSED: '图片审核通过',
  IMAGE_QA_HUMAN_PASSED: '图片抽检通过', IMAGE_QA_RETURNED: '图片质检打回', IMAGE_QA_BATCH_RELEASED: '图片免检放行',
  REASSIGNMENT_CASE_OPENED: '二次分配待处理', REASSIGNMENT_CASE_CLOSED: '二次分配已处理', DELIVERY_CONFIRMED: '交付确认',
};
const EVENT_DETAIL_LABELS: Record<string, string> = {
  from: '原负责人', to: '新负责人', reason: '原因', status: '结果', source: '来源',
  assignee: '负责人', batchId: '批次', revisionId: '文案版本', taskId: '任务',
  action: '操作', score: '评分（×10）', reasonCodes: '原因标签', qualityCycle: '质检轮次',
  imageRunId: '图片版本', targetAccountId: '新负责人账号', caseId: '改派单', itemId: '质检 / 交付项',
  legacyItemId: '历史质检项', memberId: '批次成员', mode: '方式', kind: '类型',
};

function eventDetailText(details: Record<string, unknown> | null | undefined) {
  return Object.entries(details ?? {}).filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => {
      const raw = typeof value === 'object' ? Array.isArray(value) ? value.join('、') : JSON.stringify(value) : String(value);
      const translated = key === 'source' ? ({ MANUAL: '管理员手动分配', AUTO: '自动派单' } as Record<string, string>)[raw] ?? raw
        : key === 'action' ? ({ RETRY: '打回重做', DISCARD: '废弃', PASS: '通过', RETURN_SINGLE: '单条打回', RETURN_BATCH: '整批打回' } as Record<string, string>)[raw] ?? raw
          : raw;
      return `${EVENT_DETAIL_LABELS[key] ?? key}：${translated}`;
    }).join(' · ');
}

function taskStatusText(row: TaskRow) {
  if (row.state === 'CANCELLED') return '已废弃';
  if (row.deliveredAt) return '已交付';
  if (row.state === 'REVIEWED') return '待打包';
  if (row.state === 'COPY_REVIEW_PENDING') return row.copyStatus === 'RETURNED' ? '文案待审核（返修）' : '文案待审核';
  if (row.state === 'PENDING_SECOND_ASSIGNMENT') return '文案待审核（返修）';
  if (row.state === 'COPY_QC_PENDING') return '待文案质检';
  if (row.state === 'IMAGE_RUNNING' || row.state === 'IMAGE_QUEUED') return '生图中';
  if (row.state === 'MANUAL_ARCHIVE') return '待图片审核';
  if (row.state === 'IMAGE_REWORK_PENDING') return '待图片审核（返修）';
  if (row.state === 'IMAGE_QC_PENDING') return '待图片质检';
  return STATE_LABELS[row.state] ?? row.state;
}

function OverviewCards({ overview }: { overview: ReportResponse['overview'] }) {
  const total = overview && [overview.unpacked, overview.packed, overview.delivered].every(Number.isFinite)
    ? overview.unpacked + overview.packed + overview.delivered : undefined;
  const cards = [
    { label: '新增交付数', hint: '未打包、已打包、已交付合计', count: total, Icon: Boxes },
    { label: '新增未打包', hint: '按进入交付池时间统计', count: overview?.unpacked, Icon: PackageOpen },
    { label: '新增已打包', hint: '按打包时间统计，尚未交付', count: overview?.packed, Icon: PackageCheck },
    { label: '新增已交付', hint: '按交付时间统计', count: overview?.delivered, Icon: Truck },
  ];
  return <div className={styles.overview}>
    {cards.map(({ label, hint, count, Icon }) => <div key={label} className={styles.overviewCard}>
      <div className={styles.overviewLabel}><span className={styles.overviewIcon}><Icon size={19} aria-hidden="true" /></span><div className={styles.overviewText}><span>{label}</span><small>{hint}</small></div></div>
      <strong>{count == null ? '—' : count.toLocaleString('zh-CN')}</strong>
    </div>)}
  </div>;
}

function MetricCards({ summary, visibleIds }: { summary: ReportResponse['summary']; visibleIds: MetricId[] }) {
  const counts: Record<MetricId, number> = {
    total: summary.total,
    copyReviewPending: summary.copyReviewPending,
    imageReviewPending: summary.imageReviewPending,
    copyQaPending: summary.copyQaPending,
    imageQaPending: summary.imageQaPending,
    imageQueued: summary.byState.IMAGE_QUEUED ?? 0,
    copyQaPassed: summary.copyQaPassed,
    imageQaPassed: summary.imageQaPassed,
    discarded: summary.discarded,
    packingDelivery: summary.packingDelivery,
  };
  return <div className={styles.summary}>
    {METRIC_OPTIONS.filter(option => visibleIds.includes(option.id)).map(option =>
      <div key={option.id} className={styles.summaryCard}>
        <span>{option.label}</span><strong>{counts[option.id].toLocaleString('zh-CN')}</strong>
        {option.id === 'copyQaPassed' && <small>一次质检通过 {summary.copyQaFirstPassed.toLocaleString('zh-CN')}</small>}
      </div>)}
  </div>;
}

function TaskTimeline({ taskId }: { taskId: number }) {
  const [detail, setDetail] = useState<TaskDetailResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError('');
    void apiRequest<TaskDetailResponse>(`/api/control-plane/v1/admin/task-data-report/tasks/${taskId}`, { cache: 'no-store', signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setDetail(data); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法读取任务时间线'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [taskId]);
  return <div className={styles.timeline}><div className={styles.timelineHead}><h3>任务时间线</h3>{detail && <span>读取于 {timeText(detail.asOf)}</span>}</div>
    {busy && <p role="status">正在读取流转记录…</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!busy && detail && (detail.events.length ? <ol>{detail.events.map((event, index) => <li key={`${event.at}-${event.kind}-${index}`}>
      <time>{timeText(event.at)}</time><div><strong>{EVENT_LABELS[event.kind] ?? event.kind}{event.kind.startsWith('REASSIGNMENT_CASE_') && event.stage ? ` · ${event.stage === 'COPY' ? '文案' : '图片'}` : ''}</strong>
        <span>{event.actor ? `操作人：${event.actor}` : '系统记录'}{eventDetailText(event.details) ? ` · ${eventDetailText(event.details)}` : ''}</span></div>
    </li>)}</ol> : <p>暂无可追溯的流转事件。</p>)}
    {detail?.eventsTruncated && <p className={styles.qualityNote}>事件过多，仅展示前 500 条记录。</p>}
  </div>;
}

export function TaskDataReport() {
  const [draft, setDraft] = useState<QueryConfig>(() => cleanConfig(EMPTY_CONFIG));
  const [applied, setApplied] = useState<QueryConfig>(() => cleanConfig(EMPTY_CONFIG));
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [ready, setReady] = useState(false);
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [schemeName, setSchemeName] = useState('');
  const [schemeBusy, setSchemeBusy] = useState(false);
  const [schemeMessage, setSchemeMessage] = useState('');
  const [visibleMetricIds, setVisibleMetricIds] = useState<MetricId[]>(DEFAULT_METRIC_IDS);
  const [draftMetricIds, setDraftMetricIds] = useState<MetricId[]>(DEFAULT_METRIC_IDS);
  const [metricSettingsOpen, setMetricSettingsOpen] = useState(false);
  const [metricStorageError, setMetricStorageError] = useState('');
  const [schemeOpen, setSchemeOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(METRIC_STORAGE_KEY);
      if (stored === null) return;
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        setVisibleMetricIds(METRIC_OPTIONS.filter(option => parsed.includes(option.id)).map(option => option.id));
      }
    } catch { /* Invalid or unavailable browser storage keeps the default selection. */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void apiRequest<Account[] | { items: Account[] }>(USERS_API, { cache: 'no-store' })
      .then(data => { if (!cancelled) setAccounts(Array.isArray(data) ? data : data.items ?? []); })
      .catch(() => { /* Report queries still work with numeric account IDs from saved schemes. */ });
    void apiRequest<SavedQuery[] | { items: SavedQuery[] }>(SAVED_API, { cache: 'no-store' })
      .then(data => {
        if (cancelled) return;
        const items = Array.isArray(data) ? data : data.items ?? [];
        setSaved(items);
        const preferred = items.find(item => item.isDefault);
        if (preferred?.query) {
          const config = cleanConfig(preferred.query);
          const todayConfig: QueryConfig = { ...config, pageSize: 20, time: { field: 'FIRST_COPY_REVIEW_ACTION', mode: 'ABSOLUTE', ...relativeRange(1) } };
          setDraft(todayConfig); setApplied(todayConfig); setSelectedId(preferred.id); setSchemeName(preferred.name);
        }
      })
      .catch(() => { if (!cancelled) setSchemeMessage('暂时无法读取查询方案，仍可查询任务。'); })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setReport(null); setOpenTaskId(null);
    void apiRequest<ReportResponse>(REPORT_API, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(queryBody(applied, page)), cache: 'no-store', signal: controller.signal,
    }).then(data => { if (!controller.signal.aborted) setReport(data); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '查询失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [applied, page, refresh, ready]);

  const accountOptions = useMemo(() => accounts.toSorted((a, b) =>
    (a.displayName || a.username).localeCompare(b.displayName || b.username, 'zh-CN')), [accounts]);
  const annotatorOptions = accountOptions.filter(account =>
    account.role === 'USER' && account.copyReviewEnabled !== false);
  const copyQaOptions = accountOptions.filter(account =>
    account.role === 'ADMIN' || account.copyQcEnabled === true);
  const imageQaOptions = accountOptions.filter(account =>
    account.role === 'ADMIN' || (account.role === 'REVIEWER' && account.imageQcEnabled === true));
  const selected = saved.find(item => item.id === selectedId);
  const fixedValues = useMemo(() => new Map(draft.conditions.map(condition =>
    [condition.field, condition.value] as const)), [draft.conditions]);
  const totalPages = Math.max(1, Math.ceil((report?.total ?? 0) / (report?.pageSize || draft.pageSize)));
  const invalidDate = !draft.time.from || !draft.time.to || draft.time.from > draft.time.to;
  const invalidNumber = draft.conditions.some(condition => numericCondition(condition.field) && String(condition.value).trim()
    && (!Number.isSafeInteger(Number(condition.value))
      || Number(condition.value) < (PEOPLE_FIELDS.some(([field]) => field === condition.field) ? 1 : 0)
      || (['REJECTION_COUNT', 'REASSIGNMENT_COUNT'].includes(condition.field) && Number(condition.value) > 100_000)));
  const tooManyConditions = draft.conditions.filter(condition => String(condition.value).trim()).length > 20;

  function saveMetricSettings() {
    const next = METRIC_OPTIONS.filter(option => draftMetricIds.includes(option.id)).map(option => option.id);
    try {
      window.localStorage.setItem(METRIC_STORAGE_KEY, JSON.stringify(next));
      setVisibleMetricIds(next);
      setMetricSettingsOpen(false);
      setMetricStorageError('');
    } catch {
      setMetricStorageError('无法保存到此浏览器的本地存储，请检查浏览器设置。');
    }
  }

  function updateTime(next: TimeSelection) { setDraft(previous => ({ ...previous, time: next })); }
  function updateFixed(field: ConditionField, value: string, op: Condition['op'] = 'EQ') {
    setDraft(previous => ({ ...previous, conditions: [
      ...previous.conditions.filter(condition => condition.field !== field),
      ...(value.trim() ? [{ field, op, value }] : []),
    ] }));
  }
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalidDate || invalidNumber || tooManyConditions) return;
    setPage(1); setApplied(cleanConfig(draft)); setRefresh(value => value + 1);
  }
  function chooseScheme(value: string) {
    const item = saved.find(candidate => String(candidate.id) === value);
    const config = item ? cleanConfig(item.query) : cleanConfig(EMPTY_CONFIG);
    setSelectedId(item?.id ?? null); setSchemeName(item?.name ?? ''); setSchemeMessage('');
    setDraft(config); setApplied(config); setPage(1);
  }
  async function reloadSchemes() {
    const data = await apiRequest<SavedQuery[] | { items: SavedQuery[] }>(SAVED_API, { cache: 'no-store' });
    setSaved(Array.isArray(data) ? data : data.items ?? []);
  }
  async function mutateScheme(action: 'create' | 'update' | 'default' | 'delete') {
    if ((action === 'create' || action === 'update') && (invalidDate || invalidNumber || tooManyConditions)) {
      setSchemeMessage('请先修正查询条件，再保存方案。'); return;
    }
    if ((action === 'create' || action === 'update') && !schemeName.trim()) { setSchemeMessage('请填写查询方案名称。'); return; }
    if ((action === 'update' || action === 'default' || action === 'delete') && !selectedId) return;
    if (action === 'delete' && !window.confirm(`删除查询方案“${selected?.name ?? ''}”？`)) return;
    setSchemeBusy(true); setSchemeMessage('');
    try {
      const url = action === 'create' ? SAVED_API : `${SAVED_API}/${selectedId}`;
      const method = action === 'create' ? 'POST' : action === 'delete' ? 'DELETE' : 'PATCH';
      const body = action === 'delete' ? undefined : JSON.stringify(action === 'default'
        ? { isDefault: true }
        : { name: schemeName.trim(), query: { ...draft, conditions: serializedConditions(draft.conditions) } });
      const result = await apiRequest<SavedQuery | null>(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body });
      await reloadSchemes();
      if (action === 'create' && result?.id) setSelectedId(result.id);
      if (action === 'delete') { setSelectedId(null); setSchemeName(''); }
      setSchemeMessage(action === 'create' ? '查询方案已保存。' : action === 'update' ? '查询方案已更新。' : action === 'default' ? '已设为个人默认方案。' : '查询方案已删除。');
    } catch (cause) { setSchemeMessage(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setSchemeBusy(false); }
  }

  async function exportCsv() {
    setExporting(true); setExportError('');
    try {
      const response = await fetch(EXPORT_API, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(queryBody(applied, 1)), cache: 'no-store',
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || `导出失败（${response.status}）`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = `任务数据统计-${chinaToday()}.csv`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setExportError(cause instanceof Error ? cause.message : '导出失败'); }
    finally { setExporting(false); }
  }

  return <div className={styles.page}>
    <header className={styles.header}>
      <div><span className={styles.kicker}>报表统计 / 任务数据统计</span><h1>任务数据统计</h1>
        <p>以任务为单位查看分配、标注、审核、质检与交付。每个任务只占一行。</p></div>
      <div className={styles.headerActions}>
        <Button variant="outline" size="sm" type="button" disabled={loading || !ready} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden="true" />刷新数据</Button>
      </div>
    </header>

    {schemeOpen && <div className={styles.schemeBackdrop} onClick={() => setSchemeOpen(false)}>
      <section className={`${styles.scheme} panel`} role="dialog" aria-modal="true" aria-label="查询方案设置" onClick={event => event.stopPropagation()}>
      <button type="button" className={styles.schemeClose} aria-label="关闭查询方案设置" onClick={() => setSchemeOpen(false)}><X size={18} aria-hidden="true" /></button>
      <div className={styles.schemeTitle}><strong>我的查询方案</strong><span>切换后立即查询；保存的是条件与排序，不保存结果。</span></div>
      <div className={styles.schemeControls}>
        <label>选择方案<select value={selectedId ?? ''} onChange={event => chooseScheme(event.target.value)}>
          <option value="">系统默认</option>{saved.map(item => <option key={item.id} value={item.id}>{item.name}{item.isDefault ? ' · 默认' : ''}</option>)}
        </select></label>
        <label>方案名称<input value={schemeName} onChange={event => setSchemeName(event.target.value)} maxLength={50} placeholder="例如：上月文案质检任务" /></label>
        <div className={styles.schemeActions}>
          <Button variant="outline" size="sm" type="button" disabled={schemeBusy || invalidDate || invalidNumber || tooManyConditions} onClick={() => void mutateScheme('create')}>另存为</Button>
          <Button variant="outline" size="sm" type="button" disabled={schemeBusy || !selectedId || invalidDate || invalidNumber || tooManyConditions} onClick={() => void mutateScheme('update')}>覆盖方案</Button>
          <Button variant="outline" size="sm" type="button" disabled={schemeBusy || !selectedId || selected?.isDefault} onClick={() => void mutateScheme('default')}>设为默认</Button>
          <Button variant="ghost" size="sm" type="button" disabled={schemeBusy || !selectedId} onClick={() => void mutateScheme('delete')} aria-label="删除当前查询方案"><Trash2 size={15} aria-hidden="true" /></Button>
        </div>
      </div>
      {schemeMessage && <p className={styles.schemeMessage} role="status">{schemeMessage}</p>}
    </section></div>}

    <form className={`${styles.filters} panel`} onSubmit={apply}>
      <div className={styles.primaryFilters}>
        <label>时间区间<div className={styles.dateRange}>
          <input type="date" aria-label="开始日期" value={draft.time.from} onChange={event => updateTime({ ...draft.time, from: event.target.value })} />
          <span>至</span>
          <input type="date" aria-label="结束日期" value={draft.time.to} onChange={event => updateTime({ ...draft.time, to: event.target.value })} />
        </div></label>
        <label>标注人<select value={fixedValues.get('ANNOTATOR') ?? ''} onChange={event => updateFixed('ANNOTATOR', event.target.value)}>
          <option value="">全部标注人</option>{annotatorOptions.map(account => <option key={account.id} value={account.id}>{account.displayName || account.username}（{account.username}）{account.status === 'DISABLED' ? ' · 已停用' : ''}</option>)}
        </select></label>
        <label>任务状态<select value={fixedValues.get('STATE') ?? ''} onChange={event => updateFixed('STATE', event.target.value)}>
          <option value="">全部状态</option>{FILTER_STATE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <button className={styles.moreButton} type="button" onClick={() => setMoreOpen(value => !value)} aria-expanded={moreOpen}>
          更多条件 <ChevronDown size={15} aria-hidden="true" />
        </button>
        <Button type="submit" size="sm" disabled={invalidDate || invalidNumber || tooManyConditions || loading}><Search size={15} aria-hidden="true" />查询任务</Button>
      </div>
      {moreOpen && <div className={styles.moreFilters}>
        <label>任务ID或任务名
          <input type="text" value={fixedValues.get('TASK_ID_OR_NAME') ?? ''}
            onChange={event => updateFixed('TASK_ID_OR_NAME', event.target.value, 'CONTAINS')}
            maxLength={200} placeholder="任务ID或任务名"
            title="输入 #ID 精确查询任务，其他输入按任务名查询" />
        </label>
        <label>驳回次数<select value={fixedValues.get('REJECTION_COUNT') ?? ''} onChange={event => updateFixed('REJECTION_COUNT', event.target.value)}>
          <option value="">不限</option><option value="0">0 次</option><option value="1">1 次</option><option value="2">2 次</option>
        </select></label>
        <label>改派次数（≥）<input type="number" min={0} max={100000} step={1}
          value={fixedValues.get('REASSIGNMENT_COUNT') ?? ''}
          onChange={event => updateFixed('REASSIGNMENT_COUNT', event.target.value, 'GTE')}
          placeholder="不限" /></label>
        {PEOPLE_FIELDS.filter(([field]) => field !== 'ANNOTATOR').map(([field, label, hint]) =>
          <label key={field} title={hint}>{label}<select value={fixedValues.get(field) ?? ''}
            onChange={event => updateFixed(field, event.target.value)}>
            <option value="">全部{label}</option>{(field === 'COPY_QA_REVIEWER' ? copyQaOptions : imageQaOptions).map(account =>
              <option key={account.id} value={account.id}>{account.displayName || account.username}（{account.username}）{account.status === 'DISABLED' ? ' · 已停用' : ''}</option>)}
          </select></label>)}
      </div>}
      {invalidDate && <p role="alert" className={styles.error}>请选择有效的开始和结束日期。</p>}
      {invalidNumber && <p role="alert" className={styles.error}>人员账号及次数条件应填写有效整数。</p>}
      {tooManyConditions && <p role="alert" className={styles.error}>最多可以同时使用 20 个已填写条件。</p>}
    </form>

    {error && <div role="alert" className={styles.errorBox}>{error}</div>}
    {exportError && <div role="alert" className={styles.errorBox}>{exportError}</div>}
    {report && <><section className={styles.overviewSection} aria-labelledby="task-delivery-overview-title">
      <div className={styles.overviewToolbar}>
        <h2 id="task-delivery-overview-title">任务交付概览</h2>
        <p>仅受时间区间和标注人影响</p>
      </div>
      <OverviewCards overview={report.overview} />
    </section>
    <section className={styles.summarySection} aria-label="任务数量详情">
      <div className={styles.summaryToolbar}>
        <h2>任务数量详情</h2>
        <Button variant="outline" size="sm" type="button" onClick={() => {
          setDraftMetricIds(visibleMetricIds);
          setMetricStorageError('');
          setMetricSettingsOpen(true);
        }}><Settings2 size={15} aria-hidden="true" />展示设置</Button>
      </div>
      <MetricCards summary={report.summary} visibleIds={visibleMetricIds} />
    </section>
    <section className={`${styles.results} panel`} aria-label="任务数据明细">
      <div className={styles.resultHead}><div><h2>任务明细</h2><p>共 {report.total.toLocaleString('zh-CN')} 条任务 · 第 {report.page} / {totalPages} 页 · 北京时间 · 更新于 {timeText(report.asOf)}</p></div>
        {loading && <span role="status">正在更新…</span>}</div>
      <div className={styles.tableScroll} role="region" aria-label="任务数据明细" tabIndex={0}><table><thead><tr>
        <th scope="col">任务ID</th><th scope="col">任务名</th><th scope="col">当前标注人</th><th scope="col">文案质检人</th><th scope="col">图片质检人</th><th scope="col">任务状态</th><th scope="col">驳回次数</th><th scope="col">改派次数</th>
      </tr></thead><tbody>{report.items.map(row => <FragmentRow key={row.taskId} row={row} open={openTaskId === row.taskId} onToggle={() => setOpenTaskId(current => current === row.taskId ? null : row.taskId)} />)}</tbody></table>
        {!report.items.length && <div className={styles.empty}>该范围没有符合条件的任务。可调整日期或筛选条件。</div>}
      </div>
      <div className={styles.pagination}><span>每页 {report.pageSize} 条</span><div><Button variant="outline" size="sm" type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</Button>
        <span>{page} / {totalPages}</span><Button variant="outline" size="sm" type="button" disabled={page >= totalPages || loading} onClick={() => setPage(value => value + 1)}>下一页</Button></div></div>
    </section></>}
    <Dialog open={metricSettingsOpen} onOpenChange={setMetricSettingsOpen}>
      <DialogContent className={styles.metricDialog} overlayClassName={styles.metricOverlay}>
        <DialogTitle className={styles.metricDialogTitle}>选择显示的数量标签</DialogTitle>
        <DialogDescription className={styles.metricDialogDescription}>勾选后保存，设置仅保存在当前浏览器。</DialogDescription>
        <div className={styles.metricChoices}>
          {METRIC_OPTIONS.map(option => <label key={option.id} className={styles.metricChoice}>
            <input type="checkbox" checked={draftMetricIds.includes(option.id)}
              onChange={event => setDraftMetricIds(previous => event.target.checked
                ? [...previous, option.id] : previous.filter(id => id !== option.id))} />
            <span>{option.label}</span>
          </label>)}
        </div>
        {metricStorageError && <p className={styles.error} role="alert">{metricStorageError}</p>}
        <div className={styles.metricDialogActions}>
          <Button variant="outline" type="button" onClick={() => setMetricSettingsOpen(false)}>取消</Button>
          <Button type="button" onClick={saveMetricSettings}>保存设置</Button>
        </div>
      </DialogContent>
    </Dialog>
    {!report && loading && <p className={styles.loading} role="status">正在汇总任务生命周期数据…</p>}
  </div>;
}

function AssignmentHistoryBadge({ row }: { row: TaskRow }) {
  const [position, setPosition] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const tooltipId = `task-assignment-history-${row.taskId}`;
  function show(target: HTMLSpanElement) {
    const rect = target.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const above = window.innerHeight - rect.bottom < 220 && rect.top > window.innerHeight / 2;
    setPosition(above
      ? { bottom: window.innerHeight - rect.top + 8, left }
      : { top: rect.bottom + 8, left });
  }
  return <>
    <span className={styles.reassignmentBadge} tabIndex={0}
      aria-label={`改派 ${row.reassignmentCount} 次，查看流转记录`}
      aria-describedby={position ? tooltipId : undefined}
      onMouseEnter={event => show(event.currentTarget)}
      onMouseLeave={() => setPosition(null)}
      onFocus={event => show(event.currentTarget)}
      onBlur={() => setPosition(null)}>{row.reassignmentCount}</span>
    {position && createPortal(<div id={tooltipId} role="tooltip" className={styles.assignmentTooltip} style={position}>
      <strong>标注人流转记录</strong>
      {row.annotationPeople.length ? row.annotationPeople.map((person, index) =>
        <span key={index}>{personText(person)}{person.assignedAt ? ' · ' + timeText(person.assignedAt) : ''}</span>)
        : <span>暂无可追溯的流转记录</span>}
    </div>, document.body)}
  </>;
}

function FragmentRow({ row, open, onToggle }: { row: TaskRow; open: boolean; onToggle: () => void }) {
  return <><tr className={styles.taskRow}>
    <td className={styles.taskIdCell}>{row.taskId}</td>
    <td><button className={styles.taskButton} type="button" onClick={onToggle} aria-expanded={open} aria-label={open ? '收起任务时间线' : '展开任务时间线'}>
      {open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}<span title={row.taskName}>{row.taskName || '未命名任务'}</span></button></td>
    <td><div className={styles.annotator}>{personText(row.currentAnnotator)}
      {row.reassignmentCount > 0 && <AssignmentHistoryBadge row={row} />}</div></td>
    <td className={styles.qaPeopleCell} title={peopleText(row.copyQaPeople)}>{peopleText(row.copyQaPeople)}</td>
    <td className={styles.qaPeopleCell} title={peopleText(row.imageQaPeople)}>{peopleText(row.imageQaPeople)}</td>
    <td>{taskStatusText(row)}</td>
    <td>{row.rejectionCount > 0 ? <strong className={styles.countHighlight}>{row.rejectionCount}</strong> : '—'}</td>
    <td>{row.reassignmentCount > 0 ? <strong className={styles.countHighlight}>{row.reassignmentCount}</strong> : '—'}</td>
  </tr>{open && <tr className={styles.detailRow}><td colSpan={8}><TaskTimeline taskId={row.taskId} /></td></tr>}</>;
}
