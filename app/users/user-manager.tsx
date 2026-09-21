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
}: {
  initialUsers: ManagedUser[];
  currentUsername: string;
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
    if (editor.mode === 'create') {
      const saved = await run('create', () => apiRequest('/api/control-plane/v1/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: form.get('username'),
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
          <Button unstyled className="button primary" type="button" disabled={Boolean(busy)} onClick={() => { setEditorRole('USER'); setEditor({ mode: 'create' }); }}><Plus size={16} />新增用户</Button>
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
          <thead><tr><th>用户</th><th>角色</th><th>状态</th><th>密码</th><th className="user-actions-heading">操作</th></tr></thead>
          <tbody>{visibleUsers.map((user) => {
            const isCurrentUser = user.username === currentUsername;
            return <tr key={user.id}>
              <td data-label="用户"><div className="user-identity-cell"><span className="user-avatar" aria-hidden="true">{[...user.displayName][0]?.toUpperCase() || '?'}</span><span><strong>{user.displayName}</strong><small className="mono">@{user.username}{isCurrentUser ? ' · 当前账号' : ''}</small></span></div></td>
              <td data-label="角色"><span className={`pill user-role-${user.role.toLowerCase()}`}>{ROLE_LABELS[user.role]}</span></td>
              <td data-label="状态"><span className={`pill pill-${user.status.toLowerCase()}`}>{STATUS_LABELS[user.status]}</span></td>
              <td data-label="密码"><span className={user.mustChangePassword ? 'user-password-pending' : 'user-password-ready'}>{user.mustChangePassword ? '待修改初始密码' : '已设置'}</span></td>
              <td className="row-action" data-label="操作"><div className="user-row-actions">
                <Button unstyled className="button small" type="button" disabled={Boolean(busy)} onClick={() => { setEditorRole(user.role); setEditor({ mode: 'edit', user }); }}><Pencil size={14} />编辑</Button>
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
        <form className="stack" key={editor?.mode === 'edit' ? `edit-${editorUser?.id}` : 'create'} onSubmit={saveUser}>
          {editor?.mode === 'create' && <div className="field"><label htmlFor="user-editor-username">登录账号</label><Input className="input" id="user-editor-username" name="username" pattern="[a-z0-9][a-z0-9._-]{2,49}" placeholder="例如 zhangsan" autoComplete="off" required /><small>3–50 位小写字母、数字、点、下划线或连字符。</small></div>}
          <div className="field"><label htmlFor="user-editor-display-name">姓名</label><Input className="input" id="user-editor-display-name" name="displayName" defaultValue={editorUser?.displayName ?? ''} maxLength={80} placeholder="请输入用户姓名" required /></div>
          <div className="user-editor-fields">
            <div className="field"><label htmlFor="user-editor-role">角色</label><Select name="role" value={editorRole} onValueChange={(value) => setEditorRole(value as ManagedUser['role'])}><SelectTrigger id="user-editor-role"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(ROLE_LABELS).map(([value, label]) => <SelectItem key={value} value={String(value)}>{label}</SelectItem>)}</SelectContent></Select></div>
            {editor?.mode === 'edit' && <div className="field"><label htmlFor="user-editor-status">账号状态</label><Select name="status" defaultValue={editorUser?.status}><SelectTrigger id="user-editor-status"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(STATUS_LABELS).map(([value, label]) => <SelectItem key={value} value={String(value)}>{label}</SelectItem>)}</SelectContent></Select></div>}
          </div>
          <div className="field user-editor-permissions">
            <div className="user-editor-permission-options">
              <label><input type="checkbox" name="copyReviewEnabled" defaultChecked={editorUser?.copyReviewEnabled ?? true} /> 文案审核</label>
              <label><input type="checkbox" name="copyQcEnabled" defaultChecked={editorUser?.copyQcEnabled ?? false} /> 文案质检</label>
              <label><input type="checkbox" name="imageQcEnabled" defaultChecked={editorRole === 'REVIEWER' && (editorUser?.imageQcEnabled ?? false)} disabled={editorRole !== 'REVIEWER'} /> 图片质检（仅质检）</label>
            </div>
            <small>文案审核、文案质检和图片质检独立设置；图片质检只能授予质检。图片初审无需授权，标注只初审自己负责的任务；管理员始终拥有质检管理权限。</small>
          </div>
          {error && <div className="notice error" role="alert">{error}</div>}
          <div className="user-editor-actions"><DialogClose asChild><Button unstyled className="button" type="button" disabled={editorBusy}>取消</Button></DialogClose><Button unstyled className="button primary" disabled={editorBusy}>{editorBusy ? '保存中…' : editor?.mode === 'create' ? '创建用户' : '保存修改'}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
