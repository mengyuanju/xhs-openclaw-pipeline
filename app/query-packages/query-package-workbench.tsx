'use client';

import { Button } from '@/components/ui/button';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { SearchInput } from '@/components/ui/search-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  CheckCircle2,
  FilePlus2,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  Upload,
  UserRoundCog,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { apiRequest } from '../components/api-client';
import { canCommitLatestRequest } from '../components/latest-request';
import { createRequestId } from '../components/request-id';
import styles from './query-packages.module.css';
import {
  applyQueryPackageScreening,
  normalizePackageDetail,
  normalizeQueryPackageItemAssignmentSummary,
  normalizePackagePage,
  normalizePackageSummary,
  parseQueryPackageText,
  queryPackageItemMatchesFilter,
  QUERY_PACKAGE_IMPORT_LIMIT,
  updateQueryItemSelection,
  type QueryPackageDecision,
  type QueryPackageDetail,
  type QueryPackageItemFilter,
  type QueryPackageItemAssignmentSummary,
  type QueryPackageSummary,
  type QueryPackageValidationStatus,
} from './types';
import { VirtualQueryList } from './virtual-query-list';

const apiPath = (path: string) => `/api/control-plane${path}`;
const QUERY_PACKAGE_LIST_LIMIT = 200;
const QUERY_PACKAGE_ITEM_FETCH_LIMIT = 200;
const QUERY_PACKAGE_VIRTUAL_ROW_HEIGHT = 112;
const PACKAGE_STATUS_LABELS: Record<string, string> = {
  DRAFT: '待筛选',
  IMPORTED: '待筛选',
  SCREENING: '筛选中',
  READY: '筛选完成',
  PARTIALLY_USED: '部分已创建',
  USED_UP: '已全部创建',
  ABANDONED: '已停用',
  PRODUCED: '已创建作业',
  CLOSED: '已完成',
};
const DECISION_LABELS: Record<QueryPackageDecision, string> = {
  PENDING: '待筛选',
  SELECTED: '已通过',
  REJECTED: '已淘汰',
};
const VALIDATION_STATUS_LABELS: Record<QueryPackageValidationStatus, string> = {
  READY: '可筛选', INVALID: '内容无效', DUPLICATE: '重复项', TASK_CREATED: '已创建作业',
};

type ConfirmedScreening = {
  summary: QueryPackageSummary;
  itemIds: number[];
  decision: Exclude<QueryPackageDecision, 'PENDING'>;
  reason?: string;
};

type StagedScreening = {
  itemId: number;
  expectedItemVersion: number;
  decision: 'SELECT' | 'REJECT';
};

type QueryPackageRole = 'ADMIN' | 'REVIEWER' | 'USER';
type AssignableUser = {
  id: number;
  username: string;
  displayName: string;
  role: Exclude<QueryPackageRole, 'ADMIN'>;
};
type UserDirectory = {
  identities: Array<{ id: number; username: string }>;
  assignableUsers: AssignableUser[];
};

const ROLE_LABELS: Record<QueryPackageRole, string> = {
  ADMIN: '管理员',
  REVIEWER: '审核员',
  USER: '普通用户',
};
const SCREENABLE_PACKAGE_STATUSES = new Set(['IMPORTED', 'SCREENING', 'READY', 'PARTIALLY_USED']);

function packageAllowsScreening(status: string) {
  return SCREENABLE_PACKAGE_STATUSES.has(status);
}

function userListFromPayload(value: unknown): UserDirectory | null {
  const payload = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const entries = Array.isArray(value)
    ? value
    : Array.isArray(payload?.items) ? payload.items : null;
  if (entries === null) return null;
  const identities: UserDirectory['identities'] = [];
  const assignableUsers: AssignableUser[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const user = entry as Record<string, unknown>;
    const id = Number(user.id);
    const role = String(user.role);
    const status = String(user.status);
    const username = typeof user.username === 'string' ? user.username.trim() : '';
    if (!Number.isSafeInteger(id) || id < 1 || !username
      || !['ADMIN', 'REVIEWER', 'USER'].includes(role)
      || !['ACTIVE', 'DISABLED'].includes(status)) return null;
    identities.push({ id, username });
    if (!['REVIEWER', 'USER'].includes(role) || status !== 'ACTIVE') continue;
    assignableUsers.push({
      id,
      username,
      displayName: typeof user.displayName === 'string' && user.displayName.trim()
        ? user.displayName.trim()
        : username,
      role: role as AssignableUser['role'],
    });
  }
  return { identities, assignableUsers };
}

function timeLabel(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
    : '时间未记录';
}

function assigneeLabel(item: QueryPackageSummary) {
  if (item.assignedUserCount > 0) {
    return `已按明细分给 ${item.assignedUserCount} 人 · ${item.assignedItemCount} 条待筛`;
  }
  const hasAccountId = item.assignedToAccountId !== null;
  const hasUsername = item.assignedToUserId !== null;
  if (hasAccountId !== hasUsername) return '分配记录异常（仅管理员可筛选）';
  if (!hasAccountId) return '仅管理员可筛选';
  const name = item.assignedToDisplayName || `@${item.assignedToUserId}`;
  const roleLabel = item.assignedToRole ? ROLE_LABELS[item.assignedToRole] : '筛选人';
  return `${name} · ${roleLabel}${item.assigneeStatus === 'DISABLED' ? '（已停用）' : ''}`;
}

export function QueryPackageWorkbench({ role }: { role: QueryPackageRole }) {
  const [packages, setPackages] = useState<QueryPackageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMorePackages, setLoadingMorePackages] = useState(false);
  const [nextPackageOffset, setNextPackageOffset] = useState(0);
  const [packageTotal, setPackageTotal] = useState<number | null>(null);
  const [hasMorePackages, setHasMorePackages] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [importOpen, setImportOpen] = useState(false);
  const [packageName, setPackageName] = useState('');
  const [sourceFileName, setSourceFileName] = useState('');
  const [queryText, setQueryText] = useState('');
  const [importError, setImportError] = useState('');
  const [readingImportFile, setReadingImportFile] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<QueryPackageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [itemSearch, setItemSearch] = useState('');
  const [appliedItemSearch, setAppliedItemSearch] = useState('');
  const [itemStatus, setItemStatus] = useState<QueryPackageItemFilter>('PENDING');
  const [loadingMoreItems, setLoadingMoreItems] = useState(false);
  const [checkedItemIds, setCheckedItemIds] = useState<number[]>([]);
  const [stagedScreening, setStagedScreening] = useState<Record<number, StagedScreening>>({});
  const [screeningReason, setScreeningReason] = useState('');
  const [acting, setActing] = useState('');
  const [deletePackage, setDeletePackage] = useState<QueryPackageSummary | null>(null);
  const [deletePreview, setDeletePreview] = useState<{ packageId: number; version: number; eligible: boolean; itemCount: number; productionBatchCount: number; detachedTaskCount: number; tasksWillBeDeleted: boolean } | null>(null);
  const [deletePreviewLoading, setDeletePreviewLoading] = useState(false);
  const [deletionPassword, setDeletionPassword] = useState('');
  const [confirmationName, setConfirmationName] = useState('');
  const [deletionReason, setDeletionReason] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [abandonPackage, setAbandonPackage] = useState<QueryPackageSummary | null>(null);
  const [abandonReason, setAbandonReason] = useState('');
  const [abandonError, setAbandonError] = useState('');
  const [assignPackage, setAssignPackage] = useState<QueryPackageSummary | null>(null);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [assignmentSummary, setAssignmentSummary] = useState<QueryPackageItemAssignmentSummary | null>(null);
  const [assignmentStrategy, setAssignmentStrategy] = useState<'EVEN' | 'COUNTS'>('EVEN');
  const [selectedAssigneeIds, setSelectedAssigneeIds] = useState<number[]>([]);
  const [assignmentCounts, setAssignmentCounts] = useState<Record<number, string>>({});
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignReady, setAssignReady] = useState(false);
  const [assignError, setAssignError] = useState('');
  const packageListRequestId = useRef(0);
  const packageDetailRequestId = useRef(0);
  const packageDetailRequestController = useRef<AbortController | null>(null);
  const itemLoadMoreInFlight = useRef(false);
  const deletePreviewRequest = useRef<{ id: number; controller: AbortController } | null>(null);
  const importFileRequestId = useRef(0);
  const assignmentRequestId = useRef(0);
  const assignmentRequestController = useRef<AbortController | null>(null);

  const parsedImport = useMemo(() => parseQueryPackageText(queryText), [queryText]);

  const load = useCallback(async ({ silent = false, offset = 0 } = {}) => {
    const append = offset > 0;
    const currentRequestId = ++packageListRequestId.current;
    if (append) setLoadingMorePackages(true);
    else {
      if (!silent) setRefreshing(true);
      if (!silent) setLoading(true);
    }
    try {
      const packagePayload = await apiRequest<unknown>(
        apiPath(`/v1/query-packages?limit=${QUERY_PACKAGE_LIST_LIMIT}&offset=${offset}`),
      );
      if (currentRequestId !== packageListRequestId.current) return;
      const page = normalizePackagePage(packagePayload);
      const followingOffset = offset + page.returnedCount;
      setPackages((current) => {
        if (!append) return page.items;
        const merged = new Map(current.map((item) => [item.id, item]));
        for (const item of page.items) merged.set(item.id, item);
        return [...merged.values()];
      });
      setNextPackageOffset(followingOffset);
      setPackageTotal(page.total);
      setHasMorePackages(page.total === null
        ? page.returnedCount === QUERY_PACKAGE_LIST_LIMIT
        : followingOffset < page.total);
      setError('');
    } catch (caught) {
      if (currentRequestId !== packageListRequestId.current) return;
      setError(caught instanceof Error ? caught.message : 'Query 词包读取失败');
    } finally {
      if (currentRequestId === packageListRequestId.current) {
        setLoading(false);
        setLoadingMorePackages(false);
        if (!silent) setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => () => {
    packageDetailRequestId.current += 1;
    packageDetailRequestController.current?.abort();
    deletePreviewRequest.current?.controller.abort();
    importFileRequestId.current += 1;
    assignmentRequestId.current += 1;
    assignmentRequestController.current?.abort();
  }, []);

  const visiblePackages = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    return packages.filter((item) => (status === 'ALL' || item.status === status)
      && (!keyword || `${item.name} ${item.assignedToDisplayName ?? ''} ${item.assignedToUserId ?? ''}`
        .toLocaleLowerCase('zh-CN').includes(keyword)));
  }, [packages, search, status]);

  const visibleItems = useMemo(() => {
    if (!detail) return [];
    const keyword = appliedItemSearch.toLocaleLowerCase('zh-CN');
    return detail.items.filter((item) => queryPackageItemMatchesFilter(item, itemStatus)
      && (!keyword || `${item.query} ${item.externalId ?? ''}`.toLocaleLowerCase('zh-CN').includes(keyword)));
  }, [appliedItemSearch, detail, itemStatus]);

  const checkedItemIdSet = useMemo(() => new Set(checkedItemIds), [checkedItemIds]);

  const totalCounts = useMemo(() => packages.reduce((total, item) => ({
    packages: total.packages + 1,
    queries: total.queries + item.counts.total,
    selected: total.selected + item.counts.selected,
    produced: total.produced + item.counts.produced,
  }), { packages: 0, queries: 0, selected: 0, produced: 0 }), [packages]);

  async function openPackage(
    id: number,
    {
      preserveFilters = false,
      confirmedScreening,
      appendItems = false,
      cursor = null,
      requestedItemStatus,
      requestedItemSearch,
    }: {
      preserveFilters?: boolean;
      confirmedScreening?: ConfirmedScreening;
      appendItems?: boolean;
      cursor?: string | null;
      requestedItemStatus?: QueryPackageItemFilter;
      requestedItemSearch?: string;
    } = {},
  ) {
    const effectiveItemStatus = requestedItemStatus ?? (preserveFilters ? itemStatus : 'PENDING');
    const effectiveItemSearch = (requestedItemSearch ?? (preserveFilters ? appliedItemSearch : '')).trim();
    const currentRequestId = packageDetailRequestId.current + 1;
    packageDetailRequestId.current = currentRequestId;
    packageDetailRequestController.current?.abort();
    const controller = new AbortController();
    packageDetailRequestController.current = controller;
    if (appendItems) setLoadingMoreItems(true);
    else {
      setLoadingMoreItems(false);
      setDetailLoading(true);
    }
    setDetailError('');
    if (!appendItems) {
      setDetail((current) => current?.id === id
        ? { ...current, items: [], itemPage: { total: 0, returnedCount: 0, hasMore: false, nextCursor: null } }
        : null);
      setCheckedItemIds([]);
      setScreeningReason('');
      if (!preserveFilters) {
        setStagedScreening({});
        setItemSearch('');
        setAppliedItemSearch('');
        setItemStatus('PENDING');
      }
    }
    try {
      const params = new URLSearchParams({
        itemLimit: String(QUERY_PACKAGE_ITEM_FETCH_LIMIT),
        itemFilter: effectiveItemStatus,
      });
      if (effectiveItemSearch) params.set('itemSearch', effectiveItemSearch);
      if (cursor) params.set('itemCursor', cursor);
      const payload = await apiRequest<unknown>(
        apiPath(`/v1/query-packages/${id}?${params.toString()}`),
        { signal: controller.signal },
      );
      if (!canCommitLatestRequest(packageDetailRequestId.current, currentRequestId, controller.signal.aborted)) return;
      let next = normalizePackageDetail(payload);
      if (!next) throw new Error('中心返回的词包详情不完整');
      if (confirmedScreening) {
        next = applyQueryPackageScreening(
          next,
          confirmedScreening.summary,
          confirmedScreening.itemIds,
          confirmedScreening.decision,
          confirmedScreening.reason,
        );
      }
      setDetail((current) => {
        if (!appendItems || current?.id !== id || current.version !== next.version) return next;
        const merged = new Map(current.items.map((item) => [item.id, item]));
        for (const item of next.items) merged.set(item.id, item);
        return { ...next, items: [...merged.values()] };
      });
    } catch (caught) {
      if (!canCommitLatestRequest(packageDetailRequestId.current, currentRequestId, controller.signal.aborted)) return;
      setDetailError(caught instanceof Error ? caught.message : '词包详情读取失败');
    } finally {
      if (canCommitLatestRequest(packageDetailRequestId.current, currentRequestId, controller.signal.aborted)) {
        packageDetailRequestController.current = null;
        if (appendItems) setLoadingMoreItems(false);
        else setDetailLoading(false);
      }
    }
  }

  async function loadMoreQueryItems() {
    if (!detail?.itemPage.hasMore || !detail.itemPage.nextCursor || itemLoadMoreInFlight.current || acting) return;
    itemLoadMoreInFlight.current = true;
    try {
      await openPackage(detail.id, {
        preserveFilters: true,
        appendItems: true,
        cursor: detail.itemPage.nextCursor,
      });
    } finally {
      itemLoadMoreInFlight.current = false;
    }
  }

  function changeItemStatus(nextStatus: QueryPackageItemFilter) {
    setItemStatus(nextStatus);
    setCheckedItemIds([]);
    if (detail) void openPackage(detail.id, {
      preserveFilters: true,
      requestedItemStatus: nextStatus,
    });
  }

  function applyItemSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextSearch = itemSearch.trim();
    setAppliedItemSearch(nextSearch);
    setCheckedItemIds([]);
    if (detail) void openPackage(detail.id, {
      preserveFilters: true,
      requestedItemSearch: nextSearch,
    });
  }

  function closePackageDetail() {
    packageDetailRequestId.current += 1;
    packageDetailRequestController.current?.abort();
    packageDetailRequestController.current = null;
    itemLoadMoreInFlight.current = false;
    setDetail(null);
    setDetailLoading(false);
    setLoadingMoreItems(false);
    setDetailError('');
    setCheckedItemIds([]);
    setStagedScreening({});
    setScreeningReason('');
  }

  async function readImportFile(file: File | null) {
    const currentRequestId = importFileRequestId.current + 1;
    importFileRequestId.current = currentRequestId;
    setReadingImportFile(false);
    setSourceFileName('');
    if (!file) return;
    setReadingImportFile(true);
    setQueryText('');
    setImportError('');
    try {
      const content = await file.text();
      if (!canCommitLatestRequest(importFileRequestId.current, currentRequestId)) return;
      setSourceFileName(file.name.slice(0, 255));
      setQueryText(content);
    } catch {
      if (!canCommitLatestRequest(importFileRequestId.current, currentRequestId)) return;
      setImportError('文件读取失败，请改用 UTF-8 文本文件或直接粘贴 Query。');
    } finally {
      if (canCommitLatestRequest(importFileRequestId.current, currentRequestId)) setReadingImportFile(false);
    }
  }

  function changeImportText(value: string) {
    importFileRequestId.current += 1;
    setReadingImportFile(false);
    setSourceFileName('');
    setQueryText(value);
    setImportError('');
  }

  function closeImportDialog() {
    importFileRequestId.current += 1;
    setReadingImportFile(false);
    setImportError('');
    setImportOpen(false);
  }

  async function createPackage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (role !== 'ADMIN' || creating || readingImportFile || parsedImport.error) return;
    setCreating(true);
    setImportError('');
    setMessage('');
    try {
      await apiRequest(apiPath('/v1/query-packages'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: packageName.trim(),
          ...(sourceFileName ? { sourceFileName } : {}),
          items: parsedImport.queries.map((query) => ({ query, input: {}, requestedImageCount: 'auto' })),
          requestId: createRequestId(),
        }),
      });
      closeImportDialog();
      setPackageName('');
      setSourceFileName('');
      setQueryText('');
      setMessage(`已导入 ${parsedImport.queries.length} 条 Query${parsedImport.duplicates ? `，自动忽略 ${parsedImport.duplicates} 条重复项` : ''}。`);
      await load({ silent: true });
    } catch (caught) {
      setImportError(caught instanceof Error ? caught.message : '词包导入失败');
    } finally {
      setCreating(false);
    }
  }

  async function submitScreening(decisions: StagedScreening[]) {
    if (!detail || !packageAllowsScreening(detail.status) || decisions.length === 0 || acting) return;
    setActing('screen');
    setDetailError('');
    try {
      const payload = await apiRequest<unknown>(apiPath(`/v1/query-packages/${detail.id}/screening`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: detail.version,
          decisions: decisions.map((entry) => ({
            ...entry,
            ...(entry.decision === 'REJECT' && screeningReason.trim()
              ? { reason: screeningReason.trim() }
              : {}),
          })),
          requestId: createRequestId(),
        }),
      });
      const response = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
      const summarySource = response?.queryPackage && typeof response.queryPackage === 'object'
        ? response.queryPackage
        : payload;
      const summary = normalizePackageSummary(summarySource);
      if (!summary || summary.id !== detail.id) throw new Error('筛选已提交，但中心没有返回有效的新版本');
      const selectedCount = decisions.filter((entry) => entry.decision === 'SELECT').length;
      const rejectedCount = decisions.length - selectedCount;
      setCheckedItemIds([]);
      setStagedScreening({});
      setScreeningReason('');
      setMessage(`已提交 ${decisions.length} 条筛选结果：通过 ${selectedCount} 条、淘汰 ${rejectedCount} 条${selectedCount ? '；通过项已自动进入文案生成。' : '。'}`);
      await Promise.all([
        openPackage(detail.id, {
          preserveFilters: true,
        }),
        load({ silent: true }),
      ]);
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : '筛选结果保存失败');
    } finally {
      setActing('');
    }
  }

  function screen(decision: 'SELECT' | 'REJECT') {
    if (!detail || checkedItemIds.length === 0) return;
    const checked = new Set(checkedItemIds);
    const decisions = detail.items
      .filter((item) => checked.has(item.id))
      .map((item) => ({
        itemId: item.id,
        expectedItemVersion: item.version,
        decision,
      }));
    void submitScreening(decisions);
  }

  function stageDecision(itemId: number, expectedItemVersion: number, decision: 'SELECT' | 'REJECT') {
    setStagedScreening((current) => {
      if (current[itemId]?.decision === decision) {
        const next = { ...current };
        delete next[itemId];
        return next;
      }
      return { ...current, [itemId]: { itemId, expectedItemVersion, decision } };
    });
    setDetailError('');
  }

  function submitStagedScreening() {
    void submitScreening(Object.values(stagedScreening));
  }

  async function permanentlyDelete() {
    if (role !== 'ADMIN' || !deletePackage || acting) return;
    if (deletePreview?.packageId !== deletePackage.id || !deletePreview.eligible || deletePreview.tasksWillBeDeleted || !deletionPassword || !deletionReason.trim() || confirmationName !== deletePackage.name) {
      setDeleteError('请填写删除原因和二级密码，并完整输入词包名称确认。');
      return;
    }
    setActing('delete');
    setDeleteError('');
    try {
      await apiRequest(apiPath(`/v1/query-packages/${deletePackage.id}/permanent`), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: deletePreview.version,
          reason: deletionReason.trim(),
          deletionPassword,
          confirmationName,
          requestId: createRequestId(),
        }),
      });
      setDetail((current) => current?.id === deletePackage.id ? null : current);
      setDeletePackage(null);
      setDeletionPassword('');
      setConfirmationName('');
      setDeletionReason('');
      setMessage(`词包“${deletePackage.name}”已永久删除；已经创建的正式作业保持不变。`);
      await load({ silent: true });
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : '词包永久删除失败');
    } finally {
      setActing('');
    }
  }

  async function preparePermanentDelete(item: QueryPackageSummary) {
    if (role !== 'ADMIN') return;
    deletePreviewRequest.current?.controller.abort();
    const controller = new AbortController();
    const request = { id: item.id, controller };
    deletePreviewRequest.current = request;
    setDetail((current) => current?.id === item.id ? null : current);
    setDeletePackage(item);
    setDeletePreview(null);
    setDeletionPassword('');
    setConfirmationName('');
    setDeletionReason('');
    setDeleteError('');
    setDeletePreviewLoading(true);
    try {
      const payload = await apiRequest<Record<string, unknown>>(
        apiPath(`/v1/query-packages/${item.id}/permanent-delete-preview`),
        { signal: controller.signal },
      );
      if (deletePreviewRequest.current !== request) return;
      const version = Number(payload.version);
      if (!Number.isSafeInteger(version) || version < 1) throw new Error('中心返回的删除影响预检不完整');
      setDeletePreview({
        packageId: item.id,
        version,
        eligible: payload.eligible === true,
        itemCount: Math.max(0, Number(payload.itemCount) || 0),
        productionBatchCount: Math.max(0, Number(payload.productionBatchCount) || 0),
        detachedTaskCount: Math.max(0, Number(payload.detachedTaskCount) || 0),
        tasksWillBeDeleted: payload.tasksWillBeDeleted === true,
      });
    } catch (caught) {
      if (deletePreviewRequest.current !== request || controller.signal.aborted) return;
      setDeleteError(caught instanceof Error ? caught.message : '删除影响预检失败');
    } finally {
      if (deletePreviewRequest.current === request) setDeletePreviewLoading(false);
    }
  }

  function closePermanentDelete() {
    deletePreviewRequest.current?.controller.abort();
    deletePreviewRequest.current = null;
    setDeletePackage(null);
    setDeletePreview(null);
    setDeletePreviewLoading(false);
    setDeleteError('');
  }

  async function abandon() {
    if (role !== 'ADMIN' || !abandonPackage || !abandonReason.trim() || acting) return;
    setActing('abandon');
    setAbandonError('');
    try {
      await apiRequest(apiPath(`/v1/query-packages/${abandonPackage.id}/abandon`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: abandonPackage.version, reason: abandonReason.trim(), requestId: createRequestId() }),
      });
      setAbandonPackage(null);
      setMessage(`词包“${abandonPackage.name}”已废弃；已经创建的正式作业保持不变。`);
      await load({ silent: true });
    } catch (caught) {
      setAbandonError(caught instanceof Error ? caught.message : '词包废弃失败');
    } finally {
      setActing('');
    }
  }

  function prepareAbandon(item: QueryPackageSummary) {
    if (role !== 'ADMIN') return;
    setDetail((current) => current?.id === item.id ? null : current);
    setAbandonPackage(item);
    setAbandonReason('');
    setAbandonError('');
  }

  async function openAssignment(item: QueryPackageSummary) {
    if (role !== 'ADMIN') return;
    const currentRequestId = assignmentRequestId.current + 1;
    assignmentRequestId.current = currentRequestId;
    assignmentRequestController.current?.abort();
    const controller = new AbortController();
    assignmentRequestController.current = controller;
    setAssignPackage(item);
    setAssignableUsers([]);
    setAssignmentSummary(null);
    setAssignmentStrategy('EVEN');
    setSelectedAssigneeIds([]);
    setAssignmentCounts({});
    setAssignReady(false);
    setAssignError('');
    setAssignLoading(true);
    try {
      const [payload, assignmentPayload] = await Promise.all([
        apiRequest<unknown>(apiPath('/v1/users'), { signal: controller.signal }),
        apiRequest<unknown>(
          apiPath(`/v1/query-packages/${item.id}/item-assignment-summary`),
          { signal: controller.signal },
        ),
      ]);
      if (!canCommitLatestRequest(assignmentRequestId.current, currentRequestId, controller.signal.aborted)) return;
      const directory = userListFromPayload(payload);
      if (directory === null) throw new Error('中心返回的可分配用户列表不完整，请刷新后重试。');
      const summary = normalizeQueryPackageItemAssignmentSummary(assignmentPayload);
      if (summary === null || summary.packageId !== item.id) {
        throw new Error('中心返回的 Query 分配统计不完整，请刷新后重试。');
      }
      const activeIds = new Set(directory.assignableUsers.map((user) => user.id));
      const currentIds = summary.assignees
        .map((entry) => entry.accountId)
        .filter((accountId) => activeIds.has(accountId));
      const defaultIds = currentIds.length > 0
        ? currentIds
        : directory.assignableUsers
            .slice(0, Math.min(summary.eligibleTotal, directory.assignableUsers.length))
            .map((user) => user.id);
      setAssignableUsers(directory.assignableUsers);
      setAssignmentSummary(summary);
      setAssignmentStrategy(currentIds.length > 0 ? 'COUNTS' : 'EVEN');
      setSelectedAssigneeIds(defaultIds);
      setAssignmentCounts(Object.fromEntries(summary.assignees.map((entry) => [
        entry.accountId, String(entry.count),
      ])));
      setAssignReady(true);
    } catch (caught) {
      if (!canCommitLatestRequest(assignmentRequestId.current, currentRequestId, controller.signal.aborted)) return;
      setAssignError(caught instanceof Error ? caught.message : '可分配用户读取失败');
    } finally {
      if (canCommitLatestRequest(assignmentRequestId.current, currentRequestId, controller.signal.aborted)) {
        assignmentRequestController.current = null;
        setAssignLoading(false);
      }
    }
  }

  function closeAssignmentDialog() {
    assignmentRequestId.current += 1;
    assignmentRequestController.current?.abort();
    assignmentRequestController.current = null;
    setAssignPackage(null);
    setAssignableUsers([]);
    setAssignmentSummary(null);
    setAssignmentStrategy('EVEN');
    setSelectedAssigneeIds([]);
    setAssignmentCounts({});
    setAssignLoading(false);
    setAssignReady(false);
    setAssignError('');
  }

  async function saveAssignment() {
    if (role !== 'ADMIN' || !assignPackage || !assignmentSummary
        || assignLoading || !assignReady || acting) return;
    const selected = assignableUsers.filter((candidate) => selectedAssigneeIds.includes(candidate.id));
    const assignees = selected.map((user) => ({
      accountId: user.id,
      ...(assignmentStrategy === 'COUNTS'
        ? { count: Number(assignmentCounts[user.id] ?? '') }
        : {}),
    }));
    if (assignmentStrategy === 'COUNTS' && assignees.some((entry) => (
      !Number.isSafeInteger(entry.count) || Number(entry.count) < 1
    ))) {
      setAssignError('按条数分配时，请给每位已选择人员填写至少 1 条。');
      return;
    }
    if (assignmentStrategy === 'COUNTS'
        && assignees.reduce((sum, entry) => sum + Number(entry.count), 0) > assignmentSummary.eligibleTotal) {
      setAssignError('分配总数不能超过当前待筛 Query 数量。');
      return;
    }
    setActing('assign');
    setAssignError('');
    try {
      await apiRequest(apiPath(`/v1/query-packages/${assignPackage.id}/item-assignments`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: assignmentSummary.packageVersion,
          strategy: assignmentStrategy,
          assignees,
          requestId: createRequestId(),
        }),
      });
      setMessage(selected.length > 0
        ? `词包“${assignPackage.name}”已按 Query 明细分配给 ${selected.length} 人。`
        : `词包“${assignPackage.name}”的待筛 Query 已全部收回，仅管理员可以筛选。`);
      closeAssignmentDialog();
      await load({ silent: true });
    } catch (caught) {
      setAssignError(caught instanceof Error ? caught.message : '词包筛选权限分配失败');
    } finally {
      setActing('');
    }
  }

  const detailAllowsScreening = detail !== null && packageAllowsScreening(detail.status);
  const screenableItems = detailAllowsScreening
    ? visibleItems.filter((item) => item.validationStatus === 'READY'
      && item.screeningDecision === 'PENDING' && !item.taskId)
    : [];
  const stagedScreeningItems = Object.values(stagedScreening);
  const stagedSelectedCount = stagedScreeningItems.filter((entry) => entry.decision === 'SELECT').length;
  const stagedRejectedCount = stagedScreeningItems.length - stagedSelectedCount;
  const selectedAssignmentUsers = assignableUsers.filter((user) => selectedAssigneeIds.includes(user.id));
  const plannedAssignmentCount = assignmentStrategy === 'EVEN'
    ? selectedAssignmentUsers.length > 0 ? assignmentSummary?.eligibleTotal ?? 0 : 0
    : selectedAssignmentUsers.reduce((sum, user) => {
        const count = Number(assignmentCounts[user.id]);
        return sum + (Number.isSafeInteger(count) && count > 0 ? count : 0);
      }, 0);
  const evenAssignmentCount = (index: number) => {
    if (!assignmentSummary || selectedAssignmentUsers.length === 0) return 0;
    const base = Math.floor(assignmentSummary.eligibleTotal / selectedAssignmentUsers.length);
    return base + (index < assignmentSummary.eligibleTotal % selectedAssignmentUsers.length ? 1 : 0);
  };
  const allVisibleChecked = screenableItems.length > 0 && screenableItems.every((item) => checkedItemIdSet.has(item.id));
  const availableStatuses = Object.keys(PACKAGE_STATUS_LABELS);
  const packageTotalDisplay = packageTotal === null
    ? `${packages.length.toLocaleString('zh-CN')}${hasMorePackages ? '+' : ''}`
    : packageTotal.toLocaleString('zh-CN');

  return <div className={styles.stack}>
    <section className={styles.summary} aria-label="已加载词包概况">
      <article><strong>{packageTotalDisplay}</strong><span>词包总数{packageTotal === null && hasMorePackages ? '（至少）' : ''}</span></article>
      <article><strong>{totalCounts.queries.toLocaleString('zh-CN')}</strong><span>已加载词包的 Query</span></article>
      <article><strong>{totalCounts.selected.toLocaleString('zh-CN')}</strong><span>已加载词包筛选通过</span></article>
      <article><strong>{totalCounts.produced.toLocaleString('zh-CN')}</strong><span>已加载词包已创建作业</span></article>
    </section>

    <section className="panel" aria-labelledby="query-package-list-title">
      <div className={styles.toolbar}>
        <div>
          <h2 id="query-package-list-title">词包列表</h2>
          <p className="subtle">{role === 'ADMIN'
            ? '管理员可导入词包，并把每个词包的筛选权限分配给审核员或普通用户；通过后会自动创建正式作业。'
            : '这里只显示管理员分配给你的词包；通过的 Query 会自动创建正式作业并进入文案生成。'}</p>
        </div>
        <div className={styles.toolbarGroup}>
          <Button unstyled className="button small" type="button" disabled={refreshing || loadingMorePackages} onClick={() => { void load(); }}>
            <RefreshCw aria-hidden="true" className={refreshing ? 'animate-spin' : ''} size={14} />刷新
          </Button>
          {role === 'ADMIN' && <Button unstyled className="button primary" type="button" onClick={() => { setImportError(''); setImportOpen(true); }}>
            <Upload aria-hidden="true" size={15} />导入 Query 词包
          </Button>}
        </div>
      </div>
      <div className={styles.scopeNote}>名称、筛选人和状态筛选当前覆盖已加载的 {packages.length} 个词包。{hasMorePackages ? '仍有更多词包，可继续加载后再筛选。' : '词包列表已全部加载。'}</div>

      <div className={styles.toolbar}>
        <div className={styles.toolbarGroup}>
          <SearchInput className={styles.search} value={search} onValueChange={setSearch} placeholder="搜索词包名称或筛选人" />
          <label>状态
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className={styles.filterSelect}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">全部状态</SelectItem>
                {availableStatuses.map((value) => <SelectItem key={value} value={value}>{PACKAGE_STATUS_LABELS[value] ?? value}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        </div>
      </div>

      {message && <div className="notice success" role="status">{message}</div>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {loading
        ? <div className="empty-state"><LoaderCircle className="animate-spin" size={20} />正在读取 Query 词包…</div>
        : visiblePackages.length === 0
          ? <div className="empty-state">{search || status !== 'ALL'
            ? `已加载范围内没有符合筛选条件的词包${hasMorePackages ? '；可继续加载后查找。' : '。'}`
            : role === 'ADMIN'
              ? '还没有 Query 词包。'
              : role === 'USER'
                ? '今天的词包已处理完成。'
                : '管理员暂未给你分配需要筛选的词包。'}</div>
          : <div className={`table-wrap mobile-cards ${styles.table}`}><table>
            <thead><tr><th>词包</th><th>筛选进度</th><th>状态 / 筛选人</th><th>创建时间</th><th>操作</th></tr></thead>
            <tbody>{visiblePackages.map((item) => {
              const decided = item.counts.selected + item.counts.rejected;
              return <tr key={item.id}>
                <td data-label="词包"><div className={styles.nameCell}><strong>{item.name}</strong><small>#{item.id}</small></div></td>
                <td data-label="筛选进度"><div className={styles.counts}>
                  <progress className={styles.progress} max={Math.max(1, item.counts.total)} value={decided} aria-label={`${item.name} 筛选进度`} />
                  <div className={styles.countLine}><span>待筛 {item.counts.pending}</span><span>通过 {item.counts.selected}</span><span>淘汰 {item.counts.rejected}</span><span>已创建 {item.counts.produced}</span></div>
                </div></td>
                <td data-label="状态 / 筛选人"><div className={styles.nameCell}><span className="pill">{PACKAGE_STATUS_LABELS[item.status] ?? item.status}</span><small>{assigneeLabel(item)}</small></div></td>
                <td data-label="创建时间"><time dateTime={item.createdAt}>{timeLabel(item.createdAt)}</time></td>
                <td className="row-action" data-label="操作"><div className={styles.actions}>
                  <Button unstyled className="button small primary" type="button" onClick={() => { void openPackage(item.id); }}><Search size={14} />{packageAllowsScreening(item.status) ? '筛选 Query' : '查看 Query'}</Button>
                  {role === 'ADMIN' && <Button unstyled className="button small" type="button" disabled={item.counts.pending === 0} onClick={() => { void openAssignment(item); }}><UserRoundCog size={14} />分配筛选</Button>}
                  {role === 'ADMIN' && (['USED_UP', 'ABANDONED'].includes(item.status)
                    ? <Button unstyled className="button small danger" type="button" onClick={() => { void preparePermanentDelete(item); }}><Trash2 size={14} />永久删除</Button>
                    : <Button unstyled className="button small danger" type="button" onClick={() => prepareAbandon(item)}><XCircle size={14} />废弃词包</Button>)}
                </div></td>
              </tr>;
            })}</tbody>
          </table></div>}
      {hasMorePackages && <div className={styles.loadMore}><Button unstyled className="button small" type="button" disabled={loadingMorePackages || refreshing} onClick={() => { void load({ silent: true, offset: nextPackageOffset }); }}>{loadingMorePackages ? <><LoaderCircle className="animate-spin" size={14} />正在加载…</> : '加载更多词包'}</Button></div>}
    </section>

    {role === 'ADMIN' && <Dialog open={importOpen} onOpenChange={(open) => { if (creating) return; if (open) setImportOpen(true); else closeImportDialog(); }}>
      <DialogContent className={styles.dialog}>
        <div className={styles.dialogHeader}><DialogTitle>导入 Query 词包</DialogTitle><DialogDescription>每行一条 Query，最多 {QUERY_PACKAGE_IMPORT_LIMIT.toLocaleString('zh-CN')} 条；导入后进入人工筛选，通过后自动创建正式作业。</DialogDescription></div>
        <form className={styles.importForm} onSubmit={createPackage}>
          <div className={styles.importFields}>
            <div className="field"><label htmlFor="query-package-name">词包名称</label><Input id="query-package-name" value={packageName} maxLength={120} required disabled={creating} onChange={(event) => setPackageName(event.target.value)} /></div>
            <div className="field"><label htmlFor="query-package-file">读取文本文件</label><Input id="query-package-file" type="file" accept=".txt,.csv,text/plain,text/csv" disabled={creating} onChange={(event) => { void readImportFile(event.target.files?.[0] ?? null); }} /></div>
          </div>
          <div className="field"><label htmlFor="query-package-content">Query 内容</label><Textarea id="query-package-content" className={styles.queryInput} value={queryText} rows={12} required disabled={creating} placeholder={'每行一条，例如：\n租房桌面收纳\n通勤穿搭\n周末露营装备'} onChange={(event) => changeImportText(event.target.value)} /></div>
          {readingImportFile && <div className="notice" role="status"><LoaderCircle className="animate-spin" size={15} />正在读取文件…</div>}
          {importError && <div className="notice error" role="alert">{importError}</div>}
          {queryText && parsedImport.error && <div className="notice error" role="alert">{parsedImport.error}</div>}
          <div className={styles.fileRow}><span>{sourceFileName ? `来源文件：${sourceFileName}` : '也可以直接粘贴纯文本或单列 CSV'}</span><small>识别 {parsedImport.queries.length} 条 · 重复 {parsedImport.duplicates} 条</small></div>
          <div className={styles.dialogFooter}><span>这里只导入候选 Query；点击“通过”后会自动进入文案生成。</span><div className={styles.dialogButtons}><DialogClose asChild><Button unstyled className="button" type="button" disabled={creating}>取消</Button></DialogClose><Button unstyled className="button primary" disabled={creating || readingImportFile || !packageName.trim() || Boolean(parsedImport.error)}>{creating ? '导入中…' : readingImportFile ? '读取文件中…' : '创建词包'}</Button></div></div>
        </form>
      </DialogContent>
    </Dialog>}

    <Dialog open={detail !== null || detailLoading} onOpenChange={(open) => { if (!open && !acting) closePackageDetail(); }}>
      <DialogContent className={styles.screeningDialog}>
        <div className={styles.screeningHead}><div><DialogTitle>{detail?.name ?? '读取词包'}</DialogTitle><DialogDescription>{detail
          ? detailAllowsScreening
            ? `词包 #${detail.id} · 通过的 Query 会自动创建作业并进入文案生成。`
            : `词包 #${detail.id} · 词包已结束，只能查看历史筛选结果。`
          : '正在读取词包详情…'}</DialogDescription></div>{detail && <span className="pill">{PACKAGE_STATUS_LABELS[detail.status] ?? detail.status}</span>}</div>
        {detail && <div className={styles.screeningStats}><span className="pill">全部 {detail.counts.total}</span><span className="pill">待筛 {detail.counts.pending}</span><span className="pill">通过 {detail.counts.selected}</span><span className="pill">淘汰 {detail.counts.rejected}</span><span className="pill">已创建作业 {detail.counts.produced}</span></div>}
        {detail && !detailAllowsScreening && <div className="notice" role="status">词包已结束，仅可查看历史筛选结果，不能继续通过或淘汰 Query。</div>}
        {detail && <div className={styles.screeningToolbar}><form className={styles.toolbarGroup} onSubmit={applyItemSearch}><SearchInput className={styles.search} value={itemSearch} onValueChange={setItemSearch} placeholder="搜索 Query 或外部编号" /><Button unstyled className="button small" type="submit" disabled={detailLoading}>应用搜索</Button><Select value={itemStatus} onValueChange={(value) => changeItemStatus(value as QueryPackageItemFilter)} disabled={detailLoading}><SelectTrigger className={styles.filterSelect}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部筛选结果</SelectItem><SelectItem value="PENDING">待筛选</SelectItem><SelectItem value="SELECTED">已通过</SelectItem><SelectItem value="REJECTED">已淘汰</SelectItem><SelectItem value="INVALID">内容无效</SelectItem><SelectItem value="DUPLICATE">重复项</SelectItem><SelectItem value="TASK_CREATED">已创建作业</SelectItem></SelectContent></Select></form><div className={styles.toolbarGroup}><Input value={screeningReason} maxLength={300} placeholder="淘汰原因（可选）" aria-label="筛选原因" disabled={!detailAllowsScreening} onChange={(event) => setScreeningReason(event.target.value)} /><Button unstyled className="button small primary" type="button" disabled={!detailAllowsScreening || !checkedItemIds.length || Boolean(acting)} onClick={() => screen('SELECT')}><CheckCircle2 size={14} />批量通过 {checkedItemIds.length || ''}</Button><Button unstyled className="button small danger" type="button" disabled={!detailAllowsScreening || !checkedItemIds.length || Boolean(acting)} onClick={() => screen('REJECT')}><XCircle size={14} />批量淘汰 {checkedItemIds.length || ''}</Button></div></div>}
        <div className={styles.screeningList}>
          {detailLoading && (!detail || visibleItems.length === 0) ? <div className="empty-state"><LoaderCircle className="animate-spin" size={20} />正在读取词包详情…</div>
            : detailError && (!detail || visibleItems.length === 0) ? <div className="notice error" role="alert">{detailError}</div>
              : detail && visibleItems.length ? <div className={styles.virtualTable} role="table" aria-rowcount={detail.itemPage.total + 1}>
                <div className={`${styles.virtualGrid} ${styles.virtualHeader}`} role="row"><div role="columnheader"><Checkbox aria-label="选择已加载的可筛选 Query" checked={allVisibleChecked} disabled={!detailAllowsScreening || screenableItems.length === 0} onChange={(event) => setCheckedItemIds((current) => updateQueryItemSelection(current, screenableItems.map((item) => item.id), event.target.checked))} /></div><div role="columnheader">序号</div><div role="columnheader">Query</div><div role="columnheader">筛选结果</div><div role="columnheader">操作</div><div role="columnheader">正式作业</div></div>
                <VirtualQueryList
                  count={visibleItems.length}
                  rowHeight={QUERY_PACKAGE_VIRTUAL_ROW_HEIGHT}
                  className={styles.virtualViewport}
                  innerClassName={styles.virtualInner}
                  rowClassName={`${styles.virtualGrid} ${styles.virtualRow}`}
                  hasMore={detail.itemPage.hasMore}
                  loadingMore={loadingMoreItems}
                  onEndReached={() => { void loadMoreQueryItems(); }}
                  rowKey={(index) => visibleItems[index].id}
                  renderRow={(index) => {
                    const item = visibleItems[index];
                    const screenable = detailAllowsScreening && item.validationStatus === 'READY'
                      && item.screeningDecision === 'PENDING' && !item.taskId;
                    const staged = stagedScreening[item.id];
                    return <><div role="cell"><Checkbox aria-label={`选择第 ${item.rowNumber} 条 Query 进行筛选`} checked={checkedItemIdSet.has(item.id)} disabled={!screenable} onChange={(event) => setCheckedItemIds((current) => updateQueryItemSelection(current, [item.id], event.target.checked))} /></div><div role="cell">{item.rowNumber}</div><div className={styles.queryCell} role="cell"><strong title={item.query}>{item.query}</strong>{item.externalId && <div className={styles.reason}>外部编号：{item.externalId}</div>}{role === 'ADMIN' && item.screeningAssignedToUserId && <div className={styles.reason}>负责人：@{item.screeningAssignedToUserId}</div>}{item.screeningReason && <div className={styles.reason}>筛选说明：{item.screeningReason}</div>}</div><div role="cell"><span className="pill">{staged ? staged.decision === 'SELECT' ? '待提交：通过' : '待提交：淘汰' : ['INVALID', 'DUPLICATE'].includes(item.validationStatus) ? VALIDATION_STATUS_LABELS[item.validationStatus] : DECISION_LABELS[item.screeningDecision]}</span></div><div className={styles.rowDecisionActions} role="cell"><Button unstyled className={`button small ${staged?.decision === 'SELECT' ? 'primary' : ''}`} type="button" disabled={!screenable || Boolean(acting)} onClick={() => stageDecision(item.id, item.version, 'SELECT')}><CheckCircle2 size={14} />通过</Button><Button unstyled className={`button small ${staged?.decision === 'REJECT' ? 'danger' : ''}`} type="button" disabled={!screenable || Boolean(acting)} onClick={() => stageDecision(item.id, item.version, 'REJECT')}><XCircle size={14} />淘汰</Button></div><div role="cell">{item.taskId ? `#${item.taskId}` : item.screeningDecision === 'SELECTED' ? '创建中' : '—'}</div></>;
                  }}
                />
                <div className={styles.virtualStatus}><span>已加载 {visibleItems.length} / {detail.itemPage.total} 条{appliedItemSearch ? ` · 搜索“${appliedItemSearch}”` : ''}</span>{loadingMoreItems ? <span><LoaderCircle className="animate-spin" size={14} />正在加载下一批…</span> : detail.itemPage.hasMore && <Button unstyled className="button small" type="button" onClick={() => { void loadMoreQueryItems(); }}>继续加载</Button>}</div>
              </div> : <div className="empty-state">没有符合当前筛选条件的 Query。</div>}
        </div>
        <div className={styles.screeningFooter}>{detailError
          ? <span className="notice error" role="alert">{detailError}</span>
          : detail && !detailAllowsScreening
            ? <span className="subtle">此词包当前为只读，历史筛选结果和正式作业保持不变。</span>
            : <span className="subtle">已暂存 {stagedScreeningItems.length} 条（通过 {stagedSelectedCount}、淘汰 {stagedRejectedCount}）；也可勾选后批量操作。</span>}<div>{detailAllowsScreening && <Button unstyled className="button primary" type="button" disabled={stagedScreeningItems.length === 0 || Boolean(acting)} onClick={submitStagedScreening}>{acting === 'screen' ? <><LoaderCircle className="animate-spin" size={14} />提交中…</> : `提交本批 ${stagedScreeningItems.length || ''}`}</Button>}<Button unstyled className="button" type="button" disabled={Boolean(acting)} onClick={closePackageDetail}>关闭</Button>{detail && role === 'ADMIN' && (['USED_UP', 'ABANDONED'].includes(detail.status) ? <Button unstyled className="button danger" type="button" disabled={Boolean(acting)} onClick={() => { void preparePermanentDelete(detail); }}><Trash2 size={14} />永久删除词包</Button> : <Button unstyled className="button danger" type="button" disabled={Boolean(acting)} onClick={() => prepareAbandon(detail)}><XCircle size={14} />废弃词包</Button>)}</div></div>
      </DialogContent>
    </Dialog>

    {role === 'ADMIN' && <Dialog open={abandonPackage !== null} onOpenChange={(open) => { if (!open && acting !== 'abandon') setAbandonPackage(null); }}>
      <DialogContent className={styles.dialog}>
        <div className={styles.dialogHeader}><DialogTitle>废弃 Query 词包</DialogTitle><DialogDescription>停止继续筛选这个词包。已经创建的正式作业及其审核、图片和交付数据全部保留。</DialogDescription></div>
        {abandonPackage && <form className={styles.deleteForm} onSubmit={(event) => { event.preventDefault(); void abandon(); }}>
          <div className={styles.fileRow}><strong>{abandonPackage.name}</strong><small>候选 {abandonPackage.counts.total} 条 · 已创建作业 {abandonPackage.counts.produced} 条</small></div>
          <div className="field"><label htmlFor="query-package-abandon-reason">废弃原因</label><Textarea id="query-package-abandon-reason" value={abandonReason} maxLength={500} rows={4} required disabled={acting === 'abandon'} placeholder="说明停止使用此词包的原因，内容将进入审计记录" onChange={(event) => { setAbandonReason(event.target.value); setAbandonError(''); }} /></div>
          {abandonError && <div className="notice error" role="alert">{abandonError}</div>}
          <div className={styles.dialogFooter}><span>词包废弃后如需真删除，可再执行影响预检和二级密码确认。</span><div className={styles.dialogButtons}><DialogClose asChild><Button unstyled className="button" type="button" disabled={acting === 'abandon'}>取消</Button></DialogClose><Button unstyled className="button danger" disabled={acting === 'abandon' || !abandonReason.trim()}>{acting === 'abandon' ? '废弃中…' : '确认废弃词包'}</Button></div></div>
        </form>}
      </DialogContent>
    </Dialog>}

    {role === 'ADMIN' && <Dialog open={assignPackage !== null} onOpenChange={(open) => { if (!open && acting !== 'assign') closeAssignmentDialog(); }}>
      <DialogContent className={styles.dialog}>
        <div className={styles.dialogHeader}><DialogTitle>按 Query 分配筛选任务</DialogTitle><DialogDescription>可将待筛 Query 平均分给多人，也可为每个人指定条数。作业人员只会看到分给自己的明细。</DialogDescription></div>
        {assignPackage && <div className={styles.importForm}>
          <div className={styles.fileRow}><strong>{assignPackage.name}</strong><small>{assignmentSummary ? `${assignmentSummary.eligibleTotal} 条待筛 · 已分配 ${assignmentSummary.assignedTotal} 条` : `${assignPackage.counts.pending} 条待筛`}</small></div>
          {assignLoading
            ? <div className="empty-state"><LoaderCircle className="animate-spin" size={18} />正在读取可分配用户…</div>
            : <><div className={styles.assignmentMode}><div className="field"><label htmlFor="query-package-assignment-strategy">分配方式</label><Select value={assignmentStrategy} onValueChange={(value) => {
              const nextStrategy = value as 'EVEN' | 'COUNTS';
              if (nextStrategy === 'COUNTS') {
                const selectedUsers = assignableUsers.filter((user) => selectedAssigneeIds.includes(user.id));
                const total = assignmentSummary?.eligibleTotal ?? 0;
                const quotient = selectedUsers.length > 0 ? Math.floor(total / selectedUsers.length) : 0;
                const remainder = selectedUsers.length > 0 ? total % selectedUsers.length : 0;
                setAssignmentCounts((current) => ({
                  ...current,
                  ...Object.fromEntries(selectedUsers.map((user, index) => [
                    user.id,
                    String(quotient + (index < remainder ? 1 : 0)),
                  ])),
                }));
              }
              setAssignmentStrategy(nextStrategy);
              setAssignError('');
            }}><SelectTrigger id="query-package-assignment-strategy"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="EVEN">平均分配</SelectItem><SelectItem value="COUNTS">按条数分配</SelectItem></SelectContent></Select></div><div className={styles.assignmentPreview}><strong>本次将分配 {plannedAssignmentCount} 条</strong><span>剩余 {Math.max(0, (assignmentSummary?.eligibleTotal ?? 0) - plannedAssignmentCount)} 条仅管理员可筛</span></div></div><div className={styles.assignmentList}>{assignableUsers.map((user) => {
              const selected = selectedAssigneeIds.includes(user.id);
              const selectedIndex = selectedAssignmentUsers.findIndex((entry) => entry.id === user.id);
              return <label key={user.id} className={styles.assignmentUser}><Checkbox checked={selected} aria-label={`选择 ${user.displayName}`} onChange={(event) => { setSelectedAssigneeIds((current) => event.target.checked ? [...current, user.id] : current.filter((id) => id !== user.id)); if (event.target.checked && !assignmentCounts[user.id]) setAssignmentCounts((current) => ({ ...current, [user.id]: '1' })); setAssignError(''); }} /><span><strong>{user.displayName}</strong><small>{ROLE_LABELS[user.role]} · @{user.username}</small></span>{assignmentStrategy === 'EVEN' ? <b>{selected ? evenAssignmentCount(selectedIndex) : 0} 条</b> : <Input type="number" min="1" max={assignmentSummary?.eligibleTotal ?? 0} value={assignmentCounts[user.id] ?? ''} disabled={!selected} aria-label={`${user.displayName} 分配条数`} onChange={(event) => { setAssignmentCounts((current) => ({ ...current, [user.id]: event.target.value })); setAssignError(''); }} />}</label>;
            })}</div></>}
          {!assignLoading && assignmentSummary?.eligibleTotal === 0 && <div className="notice">当前没有待筛 Query，无需重新分配。</div>}
          {!assignLoading && assignmentSummary && assignmentSummary.eligibleTotal > 0 && assignableUsers.length === 0 && <div className="notice">当前没有启用中的审核员或普通用户；保存后会收回现有待筛分配。</div>}
          {assignError && <div className="notice error" role="alert">{assignError}</div>}
          <div className={styles.dialogFooter}><span>重新分配只影响尚未筛选的 Query，已提交结果和正式作业不变；不选择任何人员即可全部收回。</span><div className={styles.dialogButtons}><DialogClose asChild><Button unstyled className="button" type="button" disabled={acting === 'assign'}>取消</Button></DialogClose><Button unstyled className="button primary" type="button" disabled={assignLoading || !assignReady || assignmentSummary?.eligibleTotal === 0 || acting === 'assign'} onClick={() => { void saveAssignment(); }}>{acting === 'assign' ? '保存中…' : '保存分配'}</Button></div></div>
        </div>}
      </DialogContent>
    </Dialog>}

    {role === 'ADMIN' && <Dialog open={deletePackage !== null} onOpenChange={(open) => { if (!open && acting !== 'delete') closePermanentDelete(); }}>
      <DialogContent className={styles.dialog}>
        <div className={styles.dialogHeader}><DialogTitle>永久删除 Query 词包</DialogTitle><DialogDescription>此操作会删除词包及其候选 Query，无法恢复。已经创建的正式作业、文案、图片和审核记录全部保留。</DialogDescription></div>
        {deletePackage && <form className={styles.deleteForm} onSubmit={(event) => { event.preventDefault(); void permanentlyDelete(); }}>
          {deletePreviewLoading ? <div className="empty-state"><LoaderCircle className="animate-spin" size={18} />正在由中心预检删除影响…</div> : deletePreview?.packageId === deletePackage.id && <div className={styles.dangerBox}><ShieldAlert size={20} /><strong>{deletePreview.eligible ? '符合永久删除条件；正式作业不会被删除' : '当前状态不允许永久删除'}</strong><p>预检范围：候选 {deletePreview.itemCount} 条、生产批次 {deletePreview.productionBatchCount} 个、已脱离词包独立保留的正式作业 {deletePreview.detachedTaskCount} 条。正式作业删除数：{deletePreview.tasksWillBeDeleted ? '异常，请停止操作' : '0'}。</p></div>}
          <div className="field"><label htmlFor="query-package-delete-reason">永久删除原因</label><Textarea id="query-package-delete-reason" value={deletionReason} maxLength={500} rows={3} required disabled={acting === 'delete'} placeholder="说明删除范围和业务原因，内容将进入审计记录" onChange={(event) => { setDeletionReason(event.target.value); setDeleteError(''); }} /></div>
          <div className="field"><label htmlFor="query-package-delete-password">管理员二级密码</label><Input id="query-package-delete-password" type="password" value={deletionPassword} autoComplete="current-password" required disabled={acting === 'delete'} onChange={(event) => { setDeletionPassword(event.target.value); setDeleteError(''); }} /></div>
          <div className="field"><label htmlFor="query-package-delete-confirmation">输入词包名称“{deletePackage.name}”确认</label><Input id="query-package-delete-confirmation" value={confirmationName} required disabled={acting === 'delete'} onChange={(event) => { setConfirmationName(event.target.value); setDeleteError(''); }} /></div>
          {deleteError && <div className="notice error" role="alert">{deleteError}</div>}
          <div className={styles.dialogFooter}><span>删除范围：词包和候选数据；保留范围：所有正式作业。</span><div className={styles.dialogButtons}><DialogClose asChild><Button unstyled className="button" type="button" disabled={acting === 'delete'}>取消</Button></DialogClose><Button unstyled className="button danger" disabled={deletePreviewLoading || deletePreview?.packageId !== deletePackage.id || !deletePreview.eligible || deletePreview.tasksWillBeDeleted || acting === 'delete' || !deletionReason.trim() || !deletionPassword || confirmationName !== deletePackage.name}>{acting === 'delete' ? <><LoaderCircle className="animate-spin" size={15} />删除中…</> : <><Trash2 size={15} />永久删除</>}</Button></div></div>
        </form>}
      </DialogContent>
    </Dialog>}
  </div>;
}
