'use client';

import { KeyRound, Pencil, Plus, ShieldCheck, Trash2, UserRound, Users } from 'lucide-react';
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

const ROLE_LABELS = { ADMIN: '管理员', REVIEWER: '审核员', USER: '普通用户' } as const;
const STATUS_LABELS = { ACTIVE: '启用', DISABLED: '停用' } as const;

type ManagedUser = {
  id: number;
  username: string;
  displayName: string;
  role: keyof typeof ROLE_LABELS;
  status: keyof typeof STATUS_LABELS;
  mustChangePassword: boolean;
  version: number;
};

type EditorState = { mode: 'create' } | { mode: 'edit'; user: ManagedUser };

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
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const activeCount = initialUsers.filter((user) => user.status === 'ACTIVE').length;
  const adminCount = initialUsers.filter((user) => user.role === 'ADMIN' && user.status === 'ACTIVE').length;

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
          role: form.get('role'),
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
        role: form.get('role'),
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

  async function deleteUser(user: ManagedUser) {
    const approved = await confirm({
      title: '删除这个用户？',
      description: `即将永久删除 ${user.displayName}（@${user.username}）的账号。已有任务记录仍会保留，但该账号将无法再登录。此操作无法撤销。`,
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
    <section className="user-summary-grid" aria-label="用户概况">
      <article className="user-summary-card"><span><Users size={18} /></span><div><strong>{initialUsers.length}</strong><small>全部用户</small></div></article>
      <article className="user-summary-card"><span className="tone-green"><UserRound size={18} /></span><div><strong>{activeCount}</strong><small>启用账号</small></div></article>
      <article className="user-summary-card"><span className="tone-amber"><ShieldCheck size={18} /></span><div><strong>{adminCount}</strong><small>启用管理员</small></div></article>
    </section>

    <section className="panel user-list-panel" aria-labelledby="user-list-title">
      <div className="panel-head user-list-head">
        <div><h2 id="user-list-title">用户列表</h2><p className="subtle">集中查看账号状态，并在弹窗中完成资料维护。</p></div>
        <button className="button primary" type="button" onClick={() => setEditor({ mode: 'create' })}><Plus size={16} />新增用户</button>
      </div>
      {(message || error) && <div className={`notice ${error ? 'error' : 'success'} user-action-notice`} role={error ? 'alert' : 'status'}>{error || message}</div>}
      {initialUsers.length === 0
        ? <div className="empty-state">还没有用户，点击“新增用户”创建第一个账号。</div>
        : <div className="table-wrap mobile-cards user-table-wrap"><table className="user-table">
          <thead><tr><th>用户</th><th>角色</th><th>状态</th><th>密码</th><th className="user-actions-heading">操作</th></tr></thead>
          <tbody>{initialUsers.map((user) => {
            const isCurrentUser = user.username === currentUsername;
            return <tr key={user.id}>
              <td data-label="用户"><div className="user-identity-cell"><span className="user-avatar" aria-hidden="true">{[...user.displayName][0]?.toUpperCase() || '?'}</span><span><strong>{user.displayName}</strong><small className="mono">@{user.username}{isCurrentUser ? ' · 当前账号' : ''}</small></span></div></td>
              <td data-label="角色"><span className={`pill user-role-${user.role.toLowerCase()}`}>{ROLE_LABELS[user.role]}</span></td>
              <td data-label="状态"><span className={`pill pill-${user.status.toLowerCase()}`}>{STATUS_LABELS[user.status]}</span></td>
              <td data-label="密码"><span className={user.mustChangePassword ? 'user-password-pending' : 'user-password-ready'}>{user.mustChangePassword ? '待修改初始密码' : '已设置'}</span></td>
              <td className="row-action" data-label="操作"><div className="user-row-actions">
                <button className="button small" type="button" disabled={Boolean(busy)} onClick={() => setEditor({ mode: 'edit', user })}><Pencil size={14} />编辑</button>
                <button className="button small" type="button" disabled={Boolean(busy)} onClick={() => { void resetPassword(user); }}><KeyRound size={14} />重置密码</button>
                <button className="button small danger user-delete-button" type="button" disabled={Boolean(busy) || isCurrentUser} title={isCurrentUser ? '不能删除当前登录账号' : '删除用户'} onClick={() => { void deleteUser(user); }}><Trash2 size={14} /><span>删除</span></button>
              </div></td>
            </tr>;
          })}</tbody>
        </table></div>}
    </section>

    <Dialog open={editor !== null} onOpenChange={(open) => { if (!open && !editorBusy) setEditor(null); }}>
      <DialogContent className="user-editor-dialog">
        <div className="user-editor-head">
          <span className="user-editor-icon"><UserRound size={20} /></span>
          <div><DialogTitle>{editor?.mode === 'create' ? '新增用户' : '编辑用户'}</DialogTitle><DialogDescription>{editor?.mode === 'create' ? '填写账号资料。创建后初始密码为 123456。' : `调整 @${editorUser?.username} 的姓名、角色和账号状态。`}</DialogDescription></div>
        </div>
        <form className="stack" key={editor?.mode === 'edit' ? `edit-${editorUser?.id}` : 'create'} onSubmit={saveUser}>
          {editor?.mode === 'create' && <div className="field"><label htmlFor="user-editor-username">登录账号</label><input className="input" id="user-editor-username" name="username" pattern="[a-z0-9][a-z0-9._-]{2,49}" placeholder="例如 zhangsan" autoComplete="off" required /><small>3–50 位小写字母、数字、点、下划线或连字符。</small></div>}
          <div className="field"><label htmlFor="user-editor-display-name">姓名</label><input className="input" id="user-editor-display-name" name="displayName" defaultValue={editorUser?.displayName ?? ''} maxLength={80} placeholder="请输入用户姓名" required /></div>
          <div className="user-editor-fields">
            <div className="field"><label htmlFor="user-editor-role">角色</label><select className="input select" id="user-editor-role" name="role" defaultValue={editorUser?.role ?? 'USER'}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
            {editor?.mode === 'edit' && <div className="field"><label htmlFor="user-editor-status">账号状态</label><select className="input select" id="user-editor-status" name="status" defaultValue={editorUser?.status}>{Object.entries(STATUS_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>}
          </div>
          {error && <div className="notice error" role="alert">{error}</div>}
          <div className="user-editor-actions"><DialogClose asChild><button className="button" type="button" disabled={editorBusy}>取消</button></DialogClose><button className="button primary" disabled={editorBusy}>{editorBusy ? '保存中…' : editor?.mode === 'create' ? '创建用户' : '保存修改'}</button></div>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
