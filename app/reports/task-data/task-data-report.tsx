'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronRight, Download, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest } from '../../components/api-client';
import styles from './task-data-report.module.css';

const REPORT_API = '/api/control-plane/v1/admin/task-data-report/query';
const EXPORT_API = '/api/control-plane/v1/admin/task-data-report/export';
const SAVED_API = '/api/control-plane/v1/admin/task-data-report/saved-queries';
const USERS_API = '/api/control-plane/v1/users';

const TIME_FIELDS = [
  ['FIRST_MANUAL_COPY_ASSIGNMENT', '首次管理员文案分配（领取）'],
  ['FIRST_COPY_ASSIGNMENT', '首次文案分配（含自动派单）'],
  ['CREATED_AT', '任务创建时间'],
  ['COPY_REVIEW_PASSED_AT', '文案审核通过时间'],
  ['COPY_QA_RELEASED_AT', '文案质检放行时间'],
  ['IMAGE_REVIEW_PASSED_AT', '图片审核通过时间'],
  ['IMAGE_QA_RELEASED_AT', '图片质检放行时间'],
] as const;
type TimeField = (typeof TIME_FIELDS)[number][0];
type TimeSelection = { field: TimeField; mode: 'RELATIVE'; days: number } | { field: TimeField; mode: 'ABSOLUTE'; from: string; to: string };

const PEOPLE_FIELDS = [
  ['ANNOTATOR', '标注人', '匹配任务历任标注人，包含驳回后的改派'],
  ['COPY_QA_REVIEWER', '文案质检人', '匹配实际作出文案质检结论的人'],
  ['IMAGE_QA_REVIEWER', '图片质检人', '匹配实际作出图片质检结论的人'],
  ['LAST_COPY_REVIEWER', '最后文案审核人', '当前有效文案版本最后审核通过人'],
  ['LAST_IMAGE_REVIEWER', '最后图片审核人', '当前有效图片版本最后审核通过人'],
] as const;
type PeopleField = (typeof PEOPLE_FIELDS)[number][0];

const EXTRA_FIELDS = [
  ['TASK_ID', '任务编号', 'number'],
  ['TASK_NAME', '任务名称 / Query', 'text'],
  ['STATE', '当前总体状态', 'state'],
  ['COPY_STATUS', '文案状态', 'stage'],
  ['IMAGE_STATUS', '图片状态', 'stage'],
  ['REJECTION_COUNT', '驳回次数', 'number'],
  ['REASSIGNMENT_COUNT', '改派次数', 'number'],
] as const;
type ExtraField = (typeof EXTRA_FIELDS)[number][0];
type ConditionField = PeopleField | ExtraField;
type Condition = { field: ConditionField; op: 'EQ' | 'CONTAINS' | 'GTE' | 'LTE'; value: string };
type QueryConfig = {
  time: TimeSelection;
  match: 'ALL' | 'ANY';
  conditions: Condition[];
  sort: 'FIRST_MANUAL_COPY_ASSIGNMENT' | 'CREATED_AT' | 'TASK_ID';
  order: 'ASC' | 'DESC';
  pageSize: number;
};
type Account = { id: number; username: string; displayName?: string; status?: string };
type Person = { accountId?: number | null; username?: string | null; displayName?: string | null; assignedAt?: string | null; source?: string | null };
type TaskRow = {
  taskId: number; taskName: string; state: string; createdAt: string | null;
  productionBatchId?: number | null; queryPackageName?: string | null;
  firstManualCopyAssignmentAt: string | null; firstCopyAssignmentAt: string | null;
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
  summary: { total: number; byState: Record<string, number>; copyQaReleased: number; imageQaReleased: number; delivered: number; withReassignment: number; withRejection: number };
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
const STAGE_OPTIONS = [
  ['PENDING', '未通过审核'], ['REVIEW_PASSED', '审核已通过'], ['QA_PENDING', '待质检'],
  ['QA_RELEASED', '质检已放行'], ['RETURNED', '已打回'],
] as const;
const STATE_LABELS = Object.fromEntries(STATE_OPTIONS);
const STAGE_LABELS = Object.fromEntries(STAGE_OPTIONS);
const EMPTY_CONFIG: QueryConfig = {
  time: { field: 'FIRST_MANUAL_COPY_ASSIGNMENT', mode: 'RELATIVE', days: 30 },
  match: 'ALL', conditions: [], sort: 'FIRST_MANUAL_COPY_ASSIGNMENT', order: 'DESC', pageSize: 50,
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
  return PEOPLE_FIELDS.some(([candidate]) => candidate === field) || ['TASK_ID', 'REJECTION_COUNT', 'REASSIGNMENT_COUNT'].includes(field);
}

function serializedConditions(conditions: Condition[]) {
  return conditions.filter(condition => String(condition.value).trim()).map(condition => ({
    ...condition, value: numericCondition(condition.field) ? Number(condition.value) : String(condition.value).trim(),
  }));
}

function queryBody(config: QueryConfig, page: number) {
  const range = config.time.mode === 'RELATIVE' ? relativeRange(config.time.days) : { from: config.time.from, to: config.time.to };
  return { time: { field: config.time.field, ...range }, match: config.match,
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

function reviewersText(people: Person[] | null | undefined) {
  return people?.length ? people.map(personText).join('、') : '—';
}

function releaseModeText(value: string | null | undefined) {
  if (!value) return '—';
  if (['PASSED', 'HUMAN_PASSED', 'MANUAL_PASSED', 'HUMAN_PASS'].includes(value)) return '抽检通过';
  if (['RELEASED', 'BATCH_RELEASED', 'UNSAMPLED', 'BATCH_RELEASE'].includes(value)) return '免检放行';
  if (value === 'ADMIN_DIRECT') return '管理员直放';
  if (value === 'NO_QA_REQUIRED_OR_LEGACY') return '历史记录 / 无需质检';
  return value;
}

function qaStatusText(value: string | null | undefined) {
  if (!value) return '—';
  const labels: Record<string, string> = {
    PASSED: '人工通过', RELEASED: '批次放行', RETURNED: '已退回', PENDING: '待质检',
    NOT_SELECTED: '未抽中，待批次结果', BATCH_AFFECTED: '整批打回波及', BATCH_RETURNED: '整批打回',
    SUPERSEDED: '已被新版本取代', NOT_REQUIRED_OR_LEGACY: '无需质检 / 历史记录',
  };
  return labels[value] ?? value;
}

function selectOptions(field: ExtraField) {
  if (field === 'STATE') return STATE_OPTIONS;
  if (field === 'COPY_STATUS' || field === 'IMAGE_STATUS') return STAGE_OPTIONS;
  return null;
}

function newCondition(field: ExtraField): Condition {
  return { field, op: field === 'TASK_NAME' ? 'CONTAINS' : 'EQ', value: '' };
}

function cleanConfig(value: QueryConfig): QueryConfig {
  // Saved configurations come from the server; keep a fresh copy for form edits.
  return { ...EMPTY_CONFIG, ...value, time: { ...value.time }, conditions: Array.isArray(value.conditions) ? value.conditions.map(condition => ({ ...condition, value: String(condition.value ?? '') })) : [] };
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

function TaskDetails({ row }: { row: TaskRow }) {
  return <div className={styles.detailContent}><div className={styles.details}>
    <div><h3>任务与分配</h3><dl>
      <div><dt>创建时间</dt><dd>{timeText(row.createdAt)}</dd></div>
      <div><dt>词包 / 批次</dt><dd>{row.queryPackageName || '—'}{row.productionBatchId ? ` / #${row.productionBatchId}` : ''}</dd></div>
      <div><dt>首次管理员文案分配</dt><dd>{timeText(row.firstManualCopyAssignmentAt)}</dd></div>
      <div><dt>首次文案分配（含自动派单）</dt><dd>{timeText(row.firstCopyAssignmentAt)}</dd></div>
      <div><dt>当前标注人</dt><dd>{personText(row.currentAnnotator)}</dd></div>
      <div><dt>历任标注人</dt><dd>{row.annotationPeople?.length ? row.annotationPeople.map((person, index) => <span key={`${person.accountId ?? 'unknown'}-${index}`} className={styles.personStep}>{personText(person)}{person.assignedAt ? ` · ${timeText(person.assignedAt)}` : ''}{person.source ? ` · ${person.source}` : ''}</span>) : '—'}</dd></div>
    </dl></div>
    <div><h3>文案</h3><dl>
      <div><dt>当前状态</dt><dd>{STAGE_LABELS[row.copyStatus] ?? row.copyStatus ?? '—'}</dd></div>
      <div><dt>最后审核人</dt><dd>{personText(row.lastCopyReviewer)}</dd></div>
      <div><dt>审核通过</dt><dd>{timeText(row.copyReviewPassedAt)}</dd></div>
      <div><dt>参与质检人</dt><dd>{reviewersText(row.copyQaPeople)}</dd></div>
      <div><dt>质检状态 / 放行方式</dt><dd>{qaStatusText(row.copyQaStatus)} · {releaseModeText(row.copyQaReleaseMode)}</dd></div>
      <div><dt>质检放行</dt><dd>{timeText(row.copyQaReleasedAt)}</dd></div>
      <div><dt>人工判定通过</dt><dd>{timeText(row.copyQaHumanPassedAt)}</dd></div>
      <div><dt>驳回次数</dt><dd>{row.copyRejectionCount ?? 0}</dd></div>
    </dl></div>
    <div><h3>图片与交付</h3><dl>
      <div><dt>当前状态</dt><dd>{STAGE_LABELS[row.imageStatus] ?? row.imageStatus ?? '—'}</dd></div>
      <div><dt>最后审核人</dt><dd>{personText(row.lastImageReviewer)}</dd></div>
      <div><dt>审核通过</dt><dd>{timeText(row.imageReviewPassedAt)}</dd></div>
      <div><dt>参与质检人</dt><dd>{reviewersText(row.imageQaPeople)}</dd></div>
      <div><dt>质检状态 / 放行方式</dt><dd>{qaStatusText(row.imageQaStatus)} · {releaseModeText(row.imageQaReleaseMode)}</dd></div>
      <div><dt>质检放行</dt><dd>{timeText(row.imageQaReleasedAt)}</dd></div>
      <div><dt>人工判定通过</dt><dd>{timeText(row.imageQaHumanPassedAt)}</dd></div>
      <div><dt>驳回次数</dt><dd>{row.imageRejectionCount ?? 0}</dd></div>
      <div><dt>交付确认</dt><dd>{timeText(row.deliveredAt)}</dd></div>
    </dl></div>
  </div>{(row.dataQuality?.assignmentHistoryIncomplete === true || row.dataQuality?.copyApprovalHistoryIncomplete === true || row.dataQuality?.imageApprovalHistoryIncomplete === true) &&
    <p className={styles.qualityNote}>这条任务的部分历史记录不完整；空白时间或人员不代表该阶段未发生。</p>}
    <TaskTimeline taskId={row.taskId} />
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
  const [openTaskId, setOpenTaskId] = useState<number | null>(null);
  const [newField, setNewField] = useState<ExtraField>('TASK_NAME');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

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
          setDraft(config); setApplied(config); setSelectedId(preferred.id); setSchemeName(preferred.name);
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
  const selected = saved.find(item => item.id === selectedId);
  const fixedValues = useMemo(() => new Map(draft.conditions.filter(condition => PEOPLE_FIELDS.some(([field]) => field === condition.field))
    .map(condition => [condition.field, condition.value])), [draft.conditions]);
  const extra = draft.conditions.filter(condition => EXTRA_FIELDS.some(([field]) => field === condition.field));
  const totalPages = Math.max(1, Math.ceil((report?.total ?? 0) / (report?.pageSize || draft.pageSize)));
  const invalidDate = draft.time.mode === 'ABSOLUTE' && (!draft.time.from || !draft.time.to || draft.time.from > draft.time.to);
  const invalidNumber = draft.conditions.some(condition => numericCondition(condition.field) && String(condition.value).trim()
    && (!Number.isSafeInteger(Number(condition.value))
      || Number(condition.value) < (condition.field === 'TASK_ID' || PEOPLE_FIELDS.some(([field]) => field === condition.field) ? 1 : 0)
      || (['REJECTION_COUNT', 'REASSIGNMENT_COUNT'].includes(condition.field) && Number(condition.value) > 100_000)));
  const tooManyConditions = draft.conditions.filter(condition => String(condition.value).trim()).length > 20;

  function updateTime(next: TimeSelection) { setDraft(previous => ({ ...previous, time: next })); }
  function updateFixed(field: PeopleField, value: string) {
    setDraft(previous => ({ ...previous, conditions: [...previous.conditions.filter(condition => condition.field !== field), ...(value ? [{ field, op: 'EQ' as const, value }] : [])] }));
  }
  function updateExtra(index: number, patch: Partial<Condition>) {
    setDraft(previous => {
      const conditions = [...previous.conditions];
      const positions = conditions.map((condition, position) => EXTRA_FIELDS.some(([field]) => field === condition.field) ? position : -1).filter(position => position >= 0);
      const position = positions[index];
      if (position !== undefined) conditions[position] = { ...conditions[position], ...patch };
      return { ...previous, conditions };
    });
  }
  function removeExtra(index: number) {
    setDraft(previous => {
      let seen = -1;
      return { ...previous, conditions: previous.conditions.filter(condition => {
        if (!EXTRA_FIELDS.some(([field]) => field === condition.field)) return true;
        seen += 1; return seen !== index;
      }) };
    });
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
      <div className={styles.headerActions}><Button variant="outline" size="sm" type="button" disabled={!report || loading || exporting} onClick={() => void exportCsv()}><Download size={15} aria-hidden="true" />{exporting ? '导出中…' : '导出 CSV'}</Button>
        <Button variant="outline" size="sm" type="button" disabled={loading || !ready} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden="true" />刷新数据</Button></div>
    </header>

    <section className={`${styles.scheme} panel`} aria-label="查询方案">
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
    </section>

    <form className={`${styles.filters} panel`} onSubmit={apply}>
      <div className={styles.sectionHead}><div><h2>查询条件</h2><p>默认时间按首次管理员文案分配（领取）计；后续驳回和改派不会重置。</p></div></div>
      <div className={styles.timeControls}>
        <label>时间参考维度<select value={draft.time.field} onChange={event => updateTime({ ...draft.time, field: event.target.value as TimeField })}>
          {TIME_FIELDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>时间区间<select value={draft.time.mode === 'RELATIVE' ? String(draft.time.days) : 'CUSTOM'} onChange={event => {
          if (event.target.value === 'CUSTOM') { const range = relativeRange(30); updateTime({ field: draft.time.field, mode: 'ABSOLUTE', ...range }); }
          else updateTime({ field: draft.time.field, mode: 'RELATIVE', days: Number(event.target.value) });
        }}><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option>
          {draft.time.mode === 'RELATIVE' && ![7, 30, 90].includes(draft.time.days) && <option value={draft.time.days}>近 {draft.time.days} 天</option>}
          <option value="CUSTOM">自定义日期</option></select></label>
        {draft.time.mode === 'ABSOLUTE' && <><label>开始日期<input type="date" value={draft.time.from} onChange={event => updateTime({ field: draft.time.field, mode: 'ABSOLUTE', from: event.target.value, to: draft.time.mode === 'ABSOLUTE' ? draft.time.to : '' })} /></label>
          <label>结束日期<input type="date" value={draft.time.to} onChange={event => updateTime({ field: draft.time.field, mode: 'ABSOLUTE', from: draft.time.mode === 'ABSOLUTE' ? draft.time.from : '', to: event.target.value })} /></label></>}
      </div>
      {draft.time.field === 'FIRST_MANUAL_COPY_ASSIGNMENT' && <p className={styles.timeHint}>此口径只包含有管理员首次文案分配记录的任务。自动派单或无法追溯该记录的历史任务，可切换至“首次文案分配（含自动派单）”或“任务创建时间”查看。</p>}
      <div className={styles.matchRow}><span>符合以下</span><select aria-label="条件组合方式" value={draft.match} onChange={event => setDraft(previous => ({ ...previous, match: event.target.value as 'ALL' | 'ANY' }))}>
        <option value="ALL">所有</option><option value="ANY">任一</option></select><span>已填写条件</span><small>时间区间始终生效；空白人员条件不参与筛选。</small></div>
      <div className={styles.peopleGrid}>{PEOPLE_FIELDS.map(([field, label, hint]) => <label key={field} title={hint}>{label}
        <select value={fixedValues.get(field) ?? ''} onChange={event => updateFixed(field, event.target.value)}>
          <option value="">全部人员</option>{accountOptions.map(account => <option key={account.id} value={account.id}>{account.displayName || account.username}（{account.username}）{account.status === 'DISABLED' ? ' · 已停用' : ''}</option>)}
        </select></label>)}</div>
      {extra.length > 0 && <div className={styles.extraList} aria-label="新增条件">{extra.map((condition, index) => {
        const field = EXTRA_FIELDS.find(([value]) => value === condition.field) ?? EXTRA_FIELDS[0];
        const options = selectOptions(condition.field as ExtraField);
        return <div className={styles.extraRow} key={`${index}-${condition.field}`}>
          <select aria-label={`第 ${index + 1} 个条件字段`} value={condition.field} onChange={event => updateExtra(index, newCondition(event.target.value as ExtraField))}>{EXTRA_FIELDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select aria-label={`第 ${index + 1} 个条件比较方式`} value={condition.op} onChange={event => updateExtra(index, { op: event.target.value as Condition['op'] })}>
            <option value="EQ">等于</option>{field[2] === 'text' && <option value="CONTAINS">包含</option>}{field[2] === 'number' && condition.field !== 'TASK_ID' && <><option value="GTE">大于等于</option><option value="LTE">小于等于</option></>}
          </select>
          {options ? <select aria-label={`第 ${index + 1} 个条件值`} value={condition.value} onChange={event => updateExtra(index, { value: event.target.value })}>
            <option value="">请选择</option>{options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select> : <input aria-label={`第 ${index + 1} 个条件值`} type={field[2] === 'number' ? 'number' : 'text'} min={field[2] === 'number' ? (condition.field === 'TASK_ID' ? 1 : 0) : undefined} max={['REJECTION_COUNT', 'REASSIGNMENT_COUNT'].includes(condition.field) ? 100_000 : undefined} step={field[2] === 'number' ? 1 : undefined} value={condition.value} onChange={event => updateExtra(index, { value: event.target.value })} placeholder={field[2] === 'number' ? '请输入数字' : '请输入关键词'} />}
          <button type="button" className={styles.remove} aria-label={`删除第 ${index + 1} 个条件`} onClick={() => removeExtra(index)}><Trash2 size={15} aria-hidden="true" /></button>
        </div>;
      })}</div>}
      <div className={styles.filterFooter}>
        <div className={styles.addCondition}><select aria-label="要添加的条件" value={newField} onChange={event => setNewField(event.target.value as ExtraField)}>{EXTRA_FIELDS.map(([field, label]) => <option key={field} value={field}>{label}</option>)}</select>
          <Button variant="outline" size="sm" type="button" disabled={draft.conditions.length >= 20} onClick={() => setDraft(previous => ({ ...previous, conditions: [...previous.conditions, newCondition(newField)] }))}><Plus size={14} aria-hidden="true" />添加条件</Button></div>
        <div className={styles.queryActions}><label>排序<select value={`${draft.sort}:${draft.order}`} onChange={event => {
          const [sort, order] = event.target.value.split(':');
          setDraft(previous => ({ ...previous, sort: sort as QueryConfig['sort'], order: order as QueryConfig['order'] }));
        }}><option value="FIRST_MANUAL_COPY_ASSIGNMENT:DESC">首次分配时间 · 新到旧</option><option value="FIRST_MANUAL_COPY_ASSIGNMENT:ASC">首次分配时间 · 旧到新</option><option value="CREATED_AT:DESC">创建时间 · 新到旧</option><option value="TASK_ID:DESC">任务编号 · 大到小</option></select></label>
          <Button type="submit" size="sm" disabled={invalidDate || invalidNumber || tooManyConditions || loading}><Search size={15} aria-hidden="true" />查询任务</Button></div>
      </div>
      {invalidDate && <p role="alert" className={styles.error}>请选择有效的开始和结束日期。</p>}
      {invalidNumber && <p role="alert" className={styles.error}>任务编号、人员账号及次数条件应填写有效整数。</p>}
      {tooManyConditions && <p role="alert" className={styles.error}>最多可以同时使用 20 个已填写条件。</p>}
    </form>

    {error && <div role="alert" className={styles.errorBox}>{error}</div>}
    {exportError && <div role="alert" className={styles.errorBox}>{exportError}</div>}
    {report && <><div className={styles.summary} aria-label="报表概览">
      {[
        ['任务总数', report.summary.total], ['文案质检已放行', report.summary.copyQaReleased], ['图片质检已放行', report.summary.imageQaReleased],
        ['已确认交付', report.summary.delivered], ['发生过驳回', report.summary.withRejection], ['发生过改派', report.summary.withReassignment],
      ].map(([label, value]) => <div key={label} className={styles.summaryCard}><span>{label}</span><strong>{Number(value ?? 0).toLocaleString('zh-CN')}</strong></div>)}
    </div>
    {(report.dataQuality?.legacyAssignmentCount || report.dataQuality?.missingFirstManualAssignmentCount) ? <p className={styles.qualityNote} role="note">
      历史分配记录可能不完整：{report.dataQuality.legacyAssignmentCount ?? 0} 条历史记录，{report.dataQuality.missingFirstManualAssignmentCount ?? 0} 条无法确认首次管理员分配时间。缺失值显示“—”，不推断为零次。
    </p> : null}
    <section className={`${styles.results} panel`} aria-label="任务数据明细">
      <div className={styles.resultHead}><div><h2>任务明细</h2><p>共 {report.total.toLocaleString('zh-CN')} 条任务 · 第 {report.page} / {totalPages} 页 · 北京时间 · 更新于 {timeText(report.asOf)}</p></div>
        {loading && <span role="status">正在更新…</span>}</div>
      <div className={styles.tableScroll} role="region" aria-label="任务数据明细，可横向滚动" tabIndex={0}><table><thead><tr>
        <th scope="col">任务</th><th scope="col">首次管理员分配</th><th scope="col">历任标注人</th><th scope="col">文案质检人</th><th scope="col">图片质检人</th>
        <th scope="col">最后文案审核人</th><th scope="col">最后图片审核人</th><th scope="col">文案状态</th><th scope="col">图片状态</th>
        <th scope="col">驳回</th><th scope="col">改派</th><th scope="col">文案审核通过</th><th scope="col">文案质检通过</th><th scope="col">文案质检放行</th><th scope="col">图片审核通过</th><th scope="col">图片质检通过</th><th scope="col">图片质检放行</th><th scope="col">交付确认</th>
      </tr></thead><tbody>{report.items.map(row => <FragmentRow key={row.taskId} row={row} open={openTaskId === row.taskId} onToggle={() => setOpenTaskId(current => current === row.taskId ? null : row.taskId)} />)}</tbody></table>
        {!report.items.length && <div className={styles.empty}>该范围没有符合条件的任务。可调整时间维度或筛选条件。</div>}
      </div>
      <div className={styles.pagination}><span>每页 {report.pageSize} 条</span><div><Button variant="outline" size="sm" type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</Button>
        <span>{page} / {totalPages}</span><Button variant="outline" size="sm" type="button" disabled={page >= totalPages || loading} onClick={() => setPage(value => value + 1)}>下一页</Button></div></div>
    </section></>}
    {!report && loading && <p className={styles.loading} role="status">正在汇总任务生命周期数据…</p>}
  </div>;
}

function FragmentRow({ row, open, onToggle }: { row: TaskRow; open: boolean; onToggle: () => void }) {
  return <><tr className={styles.taskRow}>
    <td><button className={styles.taskButton} type="button" onClick={onToggle} aria-expanded={open} aria-label={`${open ? '收起' : '展开'}任务 ${row.taskId} 详情`}>
      {open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}<span><strong>#{row.taskId}</strong><small title={row.taskName}>{row.taskName || '未命名任务'}</small><em>{STATE_LABELS[row.state] ?? row.state}</em></span></button></td>
    <td>{timeText(row.firstManualCopyAssignmentAt)}</td><td className={styles.peopleCell} title={peopleText(row.annotationPeople)}>{peopleText(row.annotationPeople)}{row.dataQuality?.assignmentHistoryIncomplete === true && <small className={styles.incomplete}>历史记录可能不完整</small>}</td>
    <td>{reviewersText(row.copyQaPeople)}</td><td>{reviewersText(row.imageQaPeople)}</td><td>{personText(row.lastCopyReviewer)}</td><td>{personText(row.lastImageReviewer)}</td>
    <td>{STAGE_LABELS[row.copyStatus] ?? row.copyStatus ?? '—'}</td><td>{STAGE_LABELS[row.imageStatus] ?? row.imageStatus ?? '—'}</td>
    <td>{row.rejectionCount ?? 0}</td><td>{row.reassignmentCount ?? 0}{row.dataQuality?.assignmentHistoryIncomplete === true && <small className={styles.incomplete}>历史记录可能不完整</small>}</td><td>{timeText(row.copyReviewPassedAt)}</td><td>{timeText(row.copyQaHumanPassedAt)}</td>
    <td><span className={styles.releaseCell}>{row.copyQaReleasedAt && <small>{releaseModeText(row.copyQaReleaseMode)}</small>}{timeText(row.copyQaReleasedAt)}</span></td>
    <td>{timeText(row.imageReviewPassedAt)}</td><td>{timeText(row.imageQaHumanPassedAt)}</td><td><span className={styles.releaseCell}>{row.imageQaReleasedAt && <small>{releaseModeText(row.imageQaReleaseMode)}</small>}{timeText(row.imageQaReleasedAt)}</span></td><td>{timeText(row.deliveredAt)}</td>
  </tr>{open && <tr className={styles.detailRow}><td colSpan={18}><TaskDetails row={row} /></td></tr>}</>;
}
