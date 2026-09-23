'use client';

import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { ToastFeedback } from '@/components/ui/sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { ChevronLeft, ChevronRight, KeyRound, LockOpen, MoreHorizontal, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

import { apiRequest } from '../components/api-client';
import { accountSamplingInputBps, accountSamplingLabel, type AccountSamplingSettings } from './copy-sampling-settings';

const ROLE_LABELS = { ADMIN: '管理员', REVIEWER: '质检', USER: '标注' } as const;
const STATUS_LABELS = { ACTIVE: '启用', DISABLED: '停用' } as const;

type ManagedUser = {
  id: number;
  username: string;
  displayName: string;
  role: keyof typeof ROLE_LABELS;
  status: keyof typeof STATUS_LABELS;
  copyReviewEnabled?: boolean;
  copyQcEnabled?: boolean;
  imageQcEnabled?: boolean;
  copySamplingRateBpsOverride?: number | null;
  autoCopyBatchEnabled?: boolean;
  autoCopyBatchSize?: number;
  copyFullInspection?: boolean;
  mustChangePassword: boolean;
  version: number;
};

type EditorState = { mode: 'create' } | { mode: 'edit'; user: ManagedUser };
type RoleFilter = 'ALL' | ManagedUser['role'];
type StatusFilter = 'ALL' | ManagedUser['status'];

const USERS_PER_PAGE = 8;

export function UserManager({
  initialUsers,
  currentUsername,
  samplingSettings = null,
}: {
  initialUsers: ManagedUser[];
  currentUsername: string;
  samplingSettings?: AccountSamplingSettings | null;
}) {
  const router = useRouter();
  const confirm = useConfirmDialog();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorRole, setEditorRole] = useState<ManagedUser['role']>('USER');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [page, setPage] = useState(1);
  const [samplingMode, setSamplingMode] = useState('INHERIT');
  const [samplingInput, setSamplingInput] = useState('');
  const [editorReviewEnabled, setEditorReviewEnabled] = useState(true);
  const [autoBatchEnabled,setAutoBatchEnabled]=useState(true);
  const [autoBatchSize,setAutoBatchSize]=useState(10);
  const [fullInspection,setFullInspection]=useState(false);
  const samplingEditable = samplingSettings?.supported === true
    && (editor?.mode === 'create' || editor?.user.copySamplingRateBpsOverride !== undefined);

  function openEditor(next: EditorState) {
    const user = next.mode === 'edit' ? next.user : null;
    setError('');
    setEditorRole(user?.role ?? 'USER');
    setEditorReviewEnabled(user?.copyReviewEnabled ?? true);
    setAutoBatchEnabled(user?.autoCopyBatchEnabled ?? true);
    setAutoBatchSize(user?.autoCopyBatchSize ?? 10);
    setFullInspection(user?.copyFullInspection ?? false);
    setSamplingMode(user?.copySamplingRateBpsOverride != null ? 'OVERRIDE' : 'INHERIT');
    setSamplingInput(String((user?.copySamplingRateBpsOverride ?? samplingSettings?.rateBps ?? 0) / 100));
    setEditor(next);
  }

  const normalizedSearch = search.trim().toLocaleLowerCase('zh-CN');
  const filteredUsers = initialUsers.filter((user) => {
    if (roleFilter !== 'ALL' && user.role !== roleFilter) return false;
    if (statusFilter !== 'ALL' && user.status !== statusFilter) return false;
    return !normalizedSearch
      || user.displayName.toLocaleLowerCase('zh-CN').includes(normalizedSearch)
      || user.username.toLocaleLowerCase('zh-CN').includes(normalizedSearch);
  });
  const pageCount = Math.max(1, Math.ceil(filteredUsers.length / USERS_PER_PAGE));
  const currentPage = Math.min(page, pageCount);
  const visibleUsers = filteredUsers.slice(
    (currentPage - 1) * USERS_PER_PAGE,
    currentPage * USERS_PER_PAGE,
  );

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
      setError(caught instanceof Error ? caught.message : '操作失败');
      return false;
    } finally {
      setBusy('');
    }
  }

  async function saveUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    const form = new FormData(event.currentTarget);
    let samplingUpdate: { copySamplingRateBpsOverride?: number | null } = {};
    try {
      if (samplingEditable) samplingUpdate = {
        copySamplingRateBpsOverride: samplingMode === 'INHERIT' ? null : accountSamplingInputBps(samplingInput),
      };
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '文案抽检比例无效');
      return;
    }
    if (editor.mode === 'create') {
      const saved = await run('create', () => apiRequest('/api/control-plane/v1/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: form.get('username'),
          ...samplingUpdate,
          autoCopyBatchEnabled:autoBatchEnabled,autoCopyBatchSize:autoBatchSize,copyFullInspection:fullInspection,
          displayName: form.get('displayName'),
          role: editorRole,
          copyReviewEnabled: form.get('copyReviewEnabled') === 'on',
          copyQcEnabled: form.get('copyQcEnabled') === 'on',
          imageQcEnabled: editorRole === 'REVIEWER' && form.get('imageQcEnabled') === 'on',
        }),
      }), '用户已创建，初始密码为 123456。');
      if (saved) setEditor(null);
      return;
    }

    const { user } = editor;
    const saved = await run(`update-${user.id}`, () => apiRequest(`/api/control-plane/v1/users/${user.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...samplingUpdate,
        autoCopyBatchEnabled:autoBatchEnabled,autoCopyBatchSize:autoBatchSize,copyFullInspection:fullInspection,
        displayName: form.get('displayName'),
        role: editorRole,
          copyReviewEnabled: form.get('copyReviewEnabled') === 'on',
          copyQcEnabled: form.get('copyQcEnabled') === 'on',
          imageQcEnabled: editorRole === 'REVIEWER' && form.get('imageQcEnabled') === 'on',
        status: form.get('status'),
        expectedVersion: user.version,
      }),
    }), '用户信息已更新。');
    if (saved) setEditor(null);
  }

  async function resetPassword(user: ManagedUser) {
    const approved = await confirm({
      title: '重置用户密码？',
      description: `将把 ${user.displayName}（@${user.username}）的密码重置为 123456，并要求其下次登录后修改。`,
      confirmLabel: '确认重置',
    });
    if (!approved) return;
    await run(`reset-${user.id}`, () => apiRequest(`/api/control-plane/v1/users/${user.id}/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }), `已将 ${user.displayName} 的密码重置为 123456。`);
  }

  async function releaseLoginLimit() {
    const approved = await confirm({
      title: '解除全部登录限制？',
      description: '将清除所有账号及全局的失败登录计数，受限账号可以立即重新登录。此操作不会修改任何账号的密码。',
      confirmLabel: '确认解除',
    });
    if (!approved) return;
    await run('release-login-limit', () => apiRequest('/api/auth/login-limit/reset', {
      method: 'POST',
    }), '已解除全部登录限制，受限账号现在可以重新登录。');
  }

  async function deleteUser(user: ManagedUser) {
    const approved = await confirm({
      title: '删除这个用户？',
      description: `即将永久删除 ${user.displayName}（@${user.username}）的账号。若该账号仍有未完成任务，系统会阻止删除并要求先转交；已完成任务记录会保留。此操作无法撤销。`,
      confirmLabel: '永久删除',
      tone: 'danger',
    });
    if (!approved) return;
    await run(`delete-${user.id}`, () => apiRequest(`/api/control-plane/v1/users/${user.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: user.version }),
    }), `用户 ${user.displayName} 已删除。`);
  }

  const editorUser = editor?.mode === 'edit' ? editor.user : null;
  const editorBusy = busy === 'create' || busy.startsWith('update-');

  return <div className="user-management-stack">
    <section className="panel user-list-panel" aria-labelledby="user-list-title">
      <div className="panel-head user-list-head">
        <div><h2 id="user-list-title">用户列表</h2><p className="subtle">集中查看账号状态，并在弹窗中完成资料维护。</p></div>
        <div className="inline">
          <Button unstyled className="button" type="button" disabled={Boolean(busy)} onClick={() => { void releaseLoginLimit(); }}><LockOpen size={16} />{busy === 'release-login-limit' ? '解除中…' : '解除登录限制'}</Button>
          <Button unstyled className="button primary" type="button" disabled={Boolean(busy)} onClick={() => openEditor({ mode: 'create' })}><Plus size={16} />新增用户</Button>
        </div>
      </div>
      <ToastFeedback id="user-manager-success" message={message} />
      <ToastFeedback id="user-manager-error" message={error} tone="error" />
      {initialUsers.length > 0 && <div className="user-list-toolbar">
        <SearchInput
          value={search}
          placeholder="搜索姓名或账号"
          disabled={Boolean(busy)}
          onValueChange={(value) => { setSearch(value); setPage(1); }}
        />
        <Select value={roleFilter} disabled={Boolean(busy)}
          onValueChange={(value) => { setRoleFilter(value as RoleFilter); setPage(1); }}>
          <SelectTrigger aria-label="按角色筛选"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">全部角色</SelectItem>
            {Object.entries(ROLE_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={statusFilter} disabled={Boolean(busy)}
          onValueChange={(value) => { setStatusFilter(value as StatusFilter); setPage(1); }}>
          <SelectTrigger aria-label="按状态筛选"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">全部状态</SelectItem>
            {Object.entries(STATUS_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="user-result-count">{filteredUsers.length} 位用户</span>
      </div>}
      {initialUsers.length === 0
        ? <div className="empty-state">还没有用户，点击“新增用户”创建第一个账号。</div>
        : filteredUsers.length === 0
          ? <div className="empty-state user-filter-empty">没有符合当前条件的用户。请调整搜索或筛选条件。</div>
        : <div className="table-wrap mobile-cards user-table-wrap" role="region" aria-label="用户列表，可横向滚动" tabIndex={0}><table className="user-table">
          <thead><tr><th>用户</th><th>角色</th><th>状态</th><th>文案抽检</th><th>自动成批</th><th>全量质检</th><th>密码</th><th className="user-actions-heading">操作</th></tr></thead>
          <tbody>{visibleUsers.map((user) => {
            const isCurrentUser = user.username === currentUsername;
            return <tr key={user.id}>
              <td data-label="用户"><div className="user-identity-cell"><span className="user-avatar" aria-hidden="true">{[...user.displayName][0]?.toUpperCase() || '?'}</span><span><strong>{user.displayName}</strong><small className="mono">@{user.username}{isCurrentUser ? ' · 当前账号' : ''}</small></span></div></td>
              <td data-label="角色"><span className={`pill user-role-${user.role.toLowerCase()}`}>{ROLE_LABELS[user.role]}</span></td>
              <td data-label="状态"><span className={`pill pill-${user.status.toLowerCase()}`}>{STATUS_LABELS[user.status]}</span></td>
              <td data-label="文案抽检">{accountSamplingLabel(samplingSettings, user.copySamplingRateBpsOverride)}</td>
              <td data-label="自动成批">{user.autoCopyBatchEnabled ? `${user.autoCopyBatchSize ?? 10} 条` : "关闭"}</td>
              <td data-label="全量质检">{user.copyFullInspection ? "开启" : "关闭"}</td>
              <td data-label="密码"><span className={user.mustChangePassword ? 'user-password-pending' : 'user-password-ready'}>{user.mustChangePassword ? '待修改初始密码' : '已设置'}</span></td>
              <td className="row-action" data-label="操作"><div className="user-row-actions">
                <Button unstyled className="button small" type="button" disabled={Boolean(busy)} onClick={() => openEditor({ mode: 'edit', user })}><Pencil size={14} />编辑</Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button unstyled className="button small user-more-button" type="button" disabled={Boolean(busy)} aria-label={`${user.displayName}的更多操作`}>
                      <MoreHorizontal size={15} />更多
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => { void resetPassword(user); }}><KeyRound size={14} />重置密码</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem tone="danger" disabled={isCurrentUser}
                      title={isCurrentUser ? '不能删除当前登录账号' : '删除用户'}
                      onSelect={() => { void deleteUser(user); }}><Trash2 size={14} />删除用户</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div></td>
            </tr>;
          })}</tbody>
        </table></div>}
      {pageCount > 1 && <nav className="user-pagination" aria-label="用户列表分页">
        <span>第 {currentPage} / {pageCount} 页</span>
        <div>
          <Button unstyled className="button small" type="button" disabled={currentPage <= 1 || Boolean(busy)}
            aria-label="上一页" onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={15} />上一页</Button>
          <Button unstyled className="button small" type="button" disabled={currentPage >= pageCount || Boolean(busy)}
            aria-label="下一页" onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>下一页<ChevronRight size={15} /></Button>
        </div>
      </nav>}
    </section>

    <Dialog open={editor !== null} onOpenChange={(open) => { if (!open && !editorBusy) setEditor(null); }}>
      <DialogContent className="user-editor-dialog">
        <div className="user-editor-head">
          <span className="user-editor-icon"><UserRound size={20} /></span>
          <div><DialogTitle>{editor?.mode === 'create' ? '新增用户' : '编辑用户'}</DialogTitle><DialogDescription>{editor?.mode === 'create' ? '填写账号资料。创建后初始密码为 123456。' : `调整 @${editorUser?.username} 的姓名、角色和账号状态。`}</DialogDescription></div>
        </div>
        <form className="user-editor-form" key={editor?.mode === 'edit' ? `edit-${editorUser?.id}` : 'create'} onSubmit={saveUser}>
          <section className="user-editor-section">
            <div className="user-editor-section-heading"><h3>基础信息</h3><p>设置账号身份与登录状态。</p></div>
            <div className="user-editor-grid">
              {editor?.mode === 'create' && <div className="field"><label htmlFor="user-editor-username">登录账号</label><Input className="input" id="user-editor-username" name="username" pattern="[a-z0-9][a-z0-9._-]{2,49}" placeholder="例如 zhangsan" autoComplete="off" required /><small>3–50 位小写字母、数字、点、下划线或连字符。</small></div>}
              <div className="field"><label htmlFor="user-editor-display-name">姓名</label><Input className="input" id="user-editor-display-name" name="displayName" defaultValue={editorUser?.displayName ?? ''} maxLength={80} placeholder="请输入用户姓名" required /></div>
              <div className="field"><label htmlFor="user-editor-role">角色</label><Select name="role" value={editorRole} onValueChange={(value) => setEditorRole(value as ManagedUser['role'])}><SelectTrigger id="user-editor-role"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(ROLE_LABELS).map(([value, label]) => <SelectItem key={value} value={String(value)}>{label}</SelectItem>)}</SelectContent></Select></div>
              {editor?.mode === 'edit' && <div className="field"><label htmlFor="user-editor-status">账号状态</label><Select name="status" defaultValue={editorUser?.status}><SelectTrigger id="user-editor-status"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(STATUS_LABELS).map(([value, label]) => <SelectItem key={value} value={String(value)}>{label}</SelectItem>)}</SelectContent></Select></div>}
            </div>
          </section>
          <section className="user-editor-section">
            <div className="user-editor-section-heading"><h3>工作权限</h3><p>按实际职责授予审核和质检权限。</p></div>
            <div className="user-editor-toggle-grid">
              <label><input type="checkbox" name="copyReviewEnabled" checked={editorReviewEnabled} onChange={(event) => setEditorReviewEnabled(event.target.checked)} /><span><strong>文案审核</strong><small>审核任务文案</small></span></label>
              <label><input type="checkbox" name="copyQcEnabled" defaultChecked={editorUser?.copyQcEnabled ?? false} /><span><strong>文案质检</strong><small>处理抽检任务</small></span></label>
              <label><input type="checkbox" name="imageQcEnabled" defaultChecked={editorRole === 'REVIEWER' && (editorUser?.imageQcEnabled ?? false)} disabled={editorRole !== 'REVIEWER'} /><span><strong>图片质检</strong><small>仅质检角色可用</small></span></label>
            </div>
          </section>
          <section className="user-editor-section">
            <div className="user-editor-section-heading"><h3>文案质检配置</h3><p>设置该账号的抽检比例与自动成批方式。</p></div>
            <div className="user-editor-grid">
              <div className="field"><label htmlFor="user-copy-sampling-mode">文案抽检比例</label>
                {samplingEditable && samplingSettings ? <>
                  <Select value={samplingMode} disabled={editorBusy} onValueChange={setSamplingMode}>
                    <SelectTrigger id="user-copy-sampling-mode"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="INHERIT">继承默认比例（{samplingSettings.rateBps / 100}%）</SelectItem><SelectItem value="OVERRIDE">单独配置</SelectItem></SelectContent>
                  </Select>
                  {samplingMode === 'OVERRIDE' && <div className="field"><label htmlFor="user-copy-sampling-rate">单独配置比例（%）</label><Input id="user-copy-sampling-rate" type="number" min={0} max={100} step={0.01} required value={samplingInput} disabled={editorBusy} onChange={(event) => setSamplingInput(event.target.value)} /></div>}
                  <small>个人自动批次按此比例随机选择质检项，只影响新批次。</small>
                  {!samplingSettings.enabled && <small>全局文案抽检已关闭，此设置会在重新开启后生效。</small>}
                </> : <small>{samplingSettings?.supported ? '账号比例未读取，请刷新后配置。' : samplingSettings ? '中心服务尚未支持账号级比例。' : '无法确认中心版本或读取生产配置。'}</small>}
              </div>
              <div className="field"><label htmlFor="auto-copy-batch-size">自动成批任务数</label><Input id="auto-copy-batch-size" type="number" min={1} max={5000} required value={autoBatchSize} onChange={event=>setAutoBatchSize(Number(event.target.value))} disabled={editorBusy||!autoBatchEnabled} /><small>待入批任务达到该数量时自动创建个人批次。</small></div>
            </div>
            <div className="user-editor-toggle-grid user-editor-quality-options">
              <label><input type="checkbox" checked={autoBatchEnabled} onChange={event=>setAutoBatchEnabled(event.target.checked)} disabled={editorBusy} /><span><strong>自动文案成批</strong><small>默认开启</small></span></label>
              <label><input type="checkbox" checked={fullInspection} onChange={event=>setFullInspection(event.target.checked)} disabled={editorBusy} /><span><strong>文案全量质检</strong><small>个人批次不按驳回率提前结束</small></span></label>
            </div>
          </section>
          {error && <div className="notice error" role="alert">{error}</div>}
          <div className="user-editor-actions"><DialogClose asChild><Button unstyled className="button" type="button" disabled={editorBusy}>取消</Button></DialogClose><Button unstyled className="button primary" disabled={editorBusy}>{editorBusy ? '保存中…' : editor?.mode === 'create' ? '创建用户' : '保存修改'}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
