'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../components/api-client';

const ROLE_LABELS: Record<string, string> = { ADMIN: '管理员', REVIEWER: '审核员', USER: '普通用户' };

export function UserManager({ initialUsers }: { initialUsers: any[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function run(key: string, action: () => Promise<unknown>, success: string) {
    setBusy(key); setMessage(''); setError('');
    try { await action(); setMessage(success); router.refresh(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '操作失败'); }
    finally { setBusy(''); }
  }

  function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    return run('create', () => apiRequest('/api/control-plane/v1/users', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: form.get('username'), displayName: form.get('displayName'), role: form.get('role') }),
    }), '用户已创建，初始密码为 123456。');
  }

  function updateUser(event: FormEvent<HTMLFormElement>, user: any) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    return run(`update-${user.id}`, () => apiRequest(`/api/control-plane/v1/users/${user.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: form.get('displayName'), role: form.get('role'), status: form.get('status'), expectedVersion: user.version }),
    }), '用户信息已更新。');
  }

  function resetPassword(user: any) {
    return run(`reset-${user.id}`, () => apiRequest(`/api/control-plane/v1/users/${user.id}/reset-password`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }), `已将 ${user.displayName} 的密码重置为 123456。`);
  }

  return <div className="review-people-grid">
    <section className="panel review-person-create">
      <div><span className="section-kicker">新增账号</span><h2>创建用户</h2></div>
      <form className="stack" onSubmit={createUser}>
        <div className="field"><label htmlFor="new-username">账号</label><input className="input" id="new-username" name="username" pattern="[a-z0-9][a-z0-9._-]{2,49}" required /></div>
        <div className="field"><label htmlFor="new-display-name">姓名</label><input className="input" id="new-display-name" name="displayName" maxLength={80} required /></div>
        <div className="field"><label htmlFor="new-role">角色</label><select className="input" id="new-role" name="role" defaultValue="USER">{Object.entries(ROLE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
        <button className="button primary" disabled={busy === 'create'}>{busy === 'create' ? '创建中…' : '创建用户'}</button>
      </form>
    </section>
    <section className="panel review-person-list">
      <div className="panel-head"><div><span className="section-kicker">账号目录</span><h2>全部用户</h2></div><strong>{initialUsers.length} 人</strong></div>
      {message && <div className="notice success" role="status">{message}</div>}{error && <div className="notice error" role="alert">{error}</div>}
      <div className="review-person-cards">{initialUsers.map((user) => <form className="review-person-card stack" key={user.id} onSubmit={(event) => updateUser(event, user)}>
        <div><strong>{user.displayName}</strong><span className="mono">@{user.username}</span></div>
        <div className="field"><label>姓名</label><input className="input" name="displayName" defaultValue={user.displayName} maxLength={80} required /></div>
        <div className="inline"><label>角色 <select className="input" name="role" defaultValue={user.role}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>状态 <select className="input" name="status" defaultValue={user.status}><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></label></div>
        <div className="inline"><span className="pill">{ROLE_LABELS[user.role]}</span>{user.mustChangePassword && <span className="pill">待修改初始密码</span>}</div>
        <div className="inline"><button className="button small primary" disabled={busy === `update-${user.id}`}>保存</button><button className="button small" type="button" disabled={busy === `reset-${user.id}`} onClick={() => resetPassword(user)}>重置为 123456</button></div>
      </form>)}</div>
    </section>
  </div>;
}
