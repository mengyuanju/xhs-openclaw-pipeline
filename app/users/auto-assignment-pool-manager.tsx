'use client';

import { CheckCircle2, ListChecks, Pencil, Plus, Trash2, UserRound, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Switch } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { apiRequest } from '../components/api-client';

type PoolUser = {
  username: string;
  displayName: string;
  role: 'ADMIN' | 'REVIEWER' | 'USER';
  status: 'ACTIVE' | 'DISABLED';
};

type AutoAssignmentSettings = {
  enabled: boolean;
  version: number;
  updatedByUsername: string | null;
  createdAt: string;
  updatedAt: string;
};

type AutoAssignmentWorker = {
  username: string;
  displayName: string | null;
  userRole: 'ADMIN' | 'REVIEWER' | 'USER' | null;
  userStatus: 'ACTIVE' | 'DISABLED' | null;
  status: 'ACTIVE' | 'PAUSED';
  assignmentLimit: number;
  currentTaskCount: number;
  availableSlots: number;
  canReceive: boolean;
  version: number;
  createdByUsername: string;
  updatedByUsername: string;
  createdAt: string;
  updatedAt: string;
};

type AutoAssignmentSnapshot = {
  settings: AutoAssignmentSettings;
  workers: AutoAssignmentWorker[];
  unassignedTaskCount: number;
};

type EditorState = { mode: 'add' } | { mode: 'edit'; username: string };

function workerPath(username: string) {
  return `/api/control-plane/v1/auto-assignment/workers/${encodeURIComponent(username)}`;
}

function workerAvailability(settingsEnabled: boolean, worker: AutoAssignmentWorker) {
  if (worker.userRole !== 'USER') return { label: '角色不再适用', tone: 'tone-red' };
  if (worker.userStatus !== 'ACTIVE') return { label: '账号已停用', tone: 'tone-red' };
  if (worker.status === 'PAUSED') return { label: '已暂停接单', tone: 'tone-amber' };
  if (!settingsEnabled) return { label: '总开关已关闭', tone: 'tone-neutral' };
  if (worker.availableSlots <= 0) return { label: '额度已满', tone: 'tone-neutral' };
  return { label: `可补 ${worker.availableSlots} 条`, tone: 'pill-active' };
}

export function AutoAssignmentPoolManager({
  users,
  initialSnapshot,
}: {
  users: PoolUser[];
  initialSnapshot: AutoAssignmentSnapshot;
}) {
  const router = useRouter();
  const confirm = useConfirmDialog();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [candidateSearch, setCandidateSearch] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const memberUsernames = new Set(initialSnapshot.workers.map((worker) => worker.username));
  const eligibleUsers = users.filter((user) => user.role === 'USER' && user.status === 'ACTIVE'
    && !memberUsernames.has(user.username));
  const normalizedSearch = candidateSearch.trim().toLocaleLowerCase('zh-CN');
  const visibleCandidates = eligibleUsers.filter((user) => !normalizedSearch
    || user.username.toLocaleLowerCase('zh-CN').includes(normalizedSearch)
    || user.displayName.toLocaleLowerCase('zh-CN').includes(normalizedSearch));
  const editorWorker = editor?.mode === 'edit'
    ? initialSnapshot.workers.find((worker) => worker.username === editor.username) ?? null
    : null;
  const availableWorkerCount = initialSnapshot.workers.filter((worker) => worker.canReceive).length;
  const effectiveAvailableSlots = initialSnapshot.settings.enabled
    ? initialSnapshot.workers.filter((worker) => worker.canReceive)
      .reduce((total, worker) => total + worker.availableSlots, 0)
    : 0;

  async function run(key: string, action: () => Promise<unknown>, success: string) {
    setBusy(key);
    setMessage('');
    setError('');
    try {
      await action();
      setMessage(success);
      router.refresh();
      return true;
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : '未知错误';
      setError(`操作失败：${detail}。已重新读取最新配置，请确认后再试。`);
      router.refresh();
      return false;
    } finally {
      setBusy('');
    }
  }

  async function updateSettings(enabled: boolean) {
    if (enabled === initialSnapshot.settings.enabled || busy) return;
    if (!enabled) {
      const approved = await confirm({
        title: '关闭自动分配？',
        description: '关闭后只会停止后续自动分配，不会回收已经分配的任务。需要恢复时可随时重新开启。',
        confirmLabel: '确认关闭',
      });
      if (!approved) return;
    }
    await run('settings', () => apiRequest('/api/control-plane/v1/auto-assignment/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled,
        expectedVersion: initialSnapshot.settings.version,
      }),
    }), enabled ? '自动分配已开启。' : '自动分配已关闭，现有任务保持原负责人。');
  }

  async function saveWorker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || busy) return;
    const form = new FormData(event.currentTarget);
    const assignmentLimit = Number(form.get('assignmentLimit'));
    if (!Number.isInteger(assignmentLimit) || assignmentLimit < 1 || assignmentLimit > 500) {
      setError('在手任务上限必须是 1–500 之间的整数。');
      return;
    }

    if (editor.mode === 'add') {
      const username = String(form.get('username') ?? '');
      const user = eligibleUsers.find((candidate) => candidate.username === username);
      if (!user) {
        setError('请选择一名已启用的普通作业员。');
        return;
      }
      const saved = await run('save-worker', () => apiRequest(workerPath(user.username), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ACTIVE', assignmentLimit }),
      }), `已将 ${user.displayName} 加入自动分配池。`);
      if (saved) setEditor(null);
      return;
    }

    const worker = editorWorker;
    if (!worker) {
      setError('该作业员已不在自动分配池中，请刷新后重试。');
      router.refresh();
      return;
    }
    const saved = await run('save-worker', () => apiRequest(workerPath(worker.username), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: worker.status,
        assignmentLimit,
        expectedVersion: worker.version,
      }),
    }), `已更新 ${worker.displayName || worker.username} 的在手任务上限。`);
    if (saved) setEditor(null);
  }

  async function updateWorkerStatus(worker: AutoAssignmentWorker) {
    const nextStatus = worker.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    const isAccountEligible = worker.userRole === 'USER' && worker.userStatus === 'ACTIVE';
    if (nextStatus === 'ACTIVE' && !isAccountEligible) {
      setError('停用账号不能恢复自动接单，请先在用户列表中启用该普通用户。');
      return;
    }
    await run(`status-${worker.username}`, () => apiRequest(workerPath(worker.username), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: nextStatus,
        assignmentLimit: worker.assignmentLimit,
        expectedVersion: worker.version,
      }),
    }), nextStatus === 'ACTIVE'
      ? `已恢复 ${worker.displayName || worker.username} 的自动接单。`
      : `已暂停 ${worker.displayName || worker.username} 的自动接单，不会回收已经分配的任务。`);
  }

  async function removeWorker(worker: AutoAssignmentWorker) {
    const approved = await confirm({
      title: '移出自动分配池？',
      description: `移出 ${worker.displayName || worker.username} 后将不再自动分配新任务，但不会回收已经分配的任务。`,
      confirmLabel: '确认移出',
      tone: 'danger',
    });
    if (!approved) return;
    await run(`remove-${worker.username}`, () => apiRequest(workerPath(worker.username), {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: worker.version }),
    }), `已将 ${worker.displayName || worker.username} 移出自动分配池。`);
  }

  function openAddEditor() {
    setCandidateSearch('');
    setMessage('');
    setError('');
    setEditor({ mode: 'add' });
  }

  function openWorkerEditor(worker: AutoAssignmentWorker) {
    setMessage('');
    setError('');
    setEditor({ mode: 'edit', username: worker.username });
  }

  return <div className="user-management-stack">
    <section className="user-summary-grid" aria-label="自动分配池概况">
      <article className="user-summary-card"><span><ListChecks size={18} /></span><div><strong>{initialSnapshot.unassignedTaskCount}</strong><small>待分配任务</small></div></article>
      <article className="user-summary-card"><span className="tone-green"><Users size={18} /></span><div><strong>{availableWorkerCount}</strong><small>可用池成员</small></div></article>
      <article className="user-summary-card"><span className="tone-amber"><CheckCircle2 size={18} /></span><div><strong>{effectiveAvailableSlots}</strong><small>当前可用名额</small></div></article>
    </section>

    <section className="panel user-list-panel" aria-labelledby="auto-assignment-pool-title">
      <div className="panel-head user-list-head">
        <div>
          <h2 id="auto-assignment-pool-title">自动分配人员池</h2>
          <p className="subtle">新建用户默认不会加入自动分配池；只有明确加入且启用的普通作业员会自动接单。</p>
        </div>
        <div className="inline">
          <label className="switch-field">
            <Switch
              aria-label="自动分配总开关"
              checked={initialSnapshot.settings.enabled}
              disabled={Boolean(busy)}
              onChange={(event) => { void updateSettings(event.currentTarget.checked); }}
            />
            <span>{initialSnapshot.settings.enabled ? '自动分配已开启' : '自动分配已关闭'}</span>
          </label>
          <Button unstyled className="button primary" type="button"
            disabled={Boolean(busy) || eligibleUsers.length === 0}
            title={eligibleUsers.length === 0 ? '没有可加入的已启用普通作业员' : '加入作业员'}
            onClick={openAddEditor}>
            <Plus size={16} />加入作业员
          </Button>
        </div>
      </div>

      {(message || error) && <div className={`notice ${error ? 'error' : 'success'} user-action-notice`}
        role={error ? 'alert' : 'status'}>{error || message}</div>}

      {initialSnapshot.workers.length === 0
        ? <div className="empty-state">人员池为空。请点击“加入作业员”明确选择需要自动接单的人员。</div>
        : <div className="table-wrap mobile-cards user-table-wrap"><table className="user-table">
          <thead><tr><th>作业员</th><th>池状态</th><th>在手任务</th><th>接单状态</th><th className="user-actions-heading">操作</th></tr></thead>
          <tbody>{initialSnapshot.workers.map((worker) => {
            const isAccountEligible = worker.userRole === 'USER' && worker.userStatus === 'ACTIVE';
            const availability = workerAvailability(initialSnapshot.settings.enabled, worker);
            const workerName = worker.displayName || worker.username;
            return <tr key={worker.username}>
              <td data-label="作业员"><div className="user-identity-cell">
                <span className="user-avatar" aria-hidden="true">{[...workerName][0]?.toUpperCase() || '?'}</span>
                <span><strong>{workerName}</strong><small className="mono">@{worker.username}</small></span>
              </div></td>
              <td data-label="池状态"><div className="inline">
                <span className={`pill ${worker.status === 'ACTIVE' ? 'pill-active' : 'tone-amber'}`}>
                  {worker.status === 'ACTIVE' ? '启用' : '暂停'}
                </span>
                {!isAccountEligible && <span className="pill tone-red">账号停用</span>}
              </div></td>
              <td data-label="在手任务">
                <strong className="mono">{worker.currentTaskCount} / {worker.assignmentLimit}</strong>
                <div className="subtle">剩余 {worker.availableSlots} 个配置名额</div>
              </td>
              <td data-label="接单状态"><span className={`pill ${availability.tone}`}>{availability.label}</span></td>
              <td className="row-action" data-label="操作"><div className="user-row-actions">
                <Button unstyled className="button small" type="button"
                  disabled={Boolean(busy) || !isAccountEligible}
                  title={!isAccountEligible ? '请先启用该普通用户' : '编辑在手任务上限'}
                  onClick={() => openWorkerEditor(worker)}><Pencil size={14} />编辑额度</Button>
                <Button unstyled className="button small" type="button"
                  disabled={Boolean(busy) || (!isAccountEligible && worker.status === 'PAUSED')}
                  title={!isAccountEligible && worker.status === 'PAUSED' ? '停用账号不能恢复自动接单' : undefined}
                  onClick={() => { void updateWorkerStatus(worker); }}>
                  {worker.status === 'ACTIVE' ? '暂停' : '恢复'}
                </Button>
                <Button unstyled className="button small danger user-delete-button" type="button"
                  disabled={Boolean(busy)} onClick={() => { void removeWorker(worker); }}>
                  <Trash2 size={14} />移出
                </Button>
              </div></td>
            </tr>;
          })}</tbody>
        </table></div>}
    </section>

    <Dialog open={editor !== null} onOpenChange={(open) => { if (!open && !busy) setEditor(null); }}>
      <DialogContent className="user-editor-dialog">
        <div className="user-editor-head">
          <span className="user-editor-icon"><UserRound size={20} /></span>
          <div>
            <DialogTitle>{editor?.mode === 'add' ? '加入自动分配池' : '编辑自动分配额度'}</DialogTitle>
            <DialogDescription>{editor?.mode === 'add'
              ? '明确选择一名作业员。保存前不会自动选择或加入任何用户。'
              : `设置 ${editorWorker?.displayName || editorWorker?.username || '该作业员'} 的在手任务上限。`}</DialogDescription>
          </div>
        </div>
        <form className="stack"
          key={editor?.mode === 'edit' ? `edit-${editor.username}-${editorWorker?.version ?? 'missing'}` : 'add'}
          onSubmit={saveWorker}>
          {editor?.mode === 'add' && <>
            <div className="field">
              <label htmlFor="auto-assignment-candidate-search">搜索作业员</label>
              <SearchInput id="auto-assignment-candidate-search" value={candidateSearch}
                placeholder="输入姓名或账号" maxLength={100} disabled={Boolean(busy)}
                onValueChange={setCandidateSearch} />
            </div>
            <div className="field">
              <label htmlFor="auto-assignment-worker">作业员</label>
              <Select name="username" required disabled={Boolean(busy) || visibleCandidates.length === 0}>
                <SelectTrigger id="auto-assignment-worker"><SelectValue placeholder="请选择作业员" /></SelectTrigger>
                <SelectContent>{visibleCandidates.map((user) => <SelectItem key={user.username} value={user.username}>
                  {user.displayName}（@{user.username}）
                </SelectItem>)}</SelectContent>
              </Select>
              <small>{visibleCandidates.length === 0
                ? '没有匹配的可加入人员。候选范围仅包含尚未入池的已启用普通用户。'
                : '默认不选择任何人；请选择后再保存。'}</small>
            </div>
          </>}
          {editor?.mode === 'edit' && !editorWorker
            ? <div className="notice error" role="alert">该作业员已被其他管理员移出，请关闭弹窗后重试。</div>
            : <div className="field">
              <label htmlFor="auto-assignment-limit">在手任务上限</label>
              <Input id="auto-assignment-limit" name="assignmentLimit" type="number" min={1} max={500} step={1}
                inputMode="numeric" defaultValue={editorWorker?.assignmentLimit ?? 10} disabled={Boolean(busy)} required />
              <small>允许范围为 1–500。作业员完成任务后，系统会继续补充到这个数量。</small>
            </div>}
          {error && <div className="notice error" role="alert">{error}</div>}
          <div className="user-editor-actions">
            <DialogClose asChild><Button unstyled className="button" type="button" disabled={Boolean(busy)}>取消</Button></DialogClose>
            <Button unstyled className="button primary" type="submit"
              disabled={Boolean(busy) || (editor?.mode === 'edit' && !editorWorker)}>
              {busy === 'save-worker' ? '保存中…' : editor?.mode === 'add' ? '确认加入' : '保存额度'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
