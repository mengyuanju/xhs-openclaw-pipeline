'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { apiRequest } from '../../components/api-client';

const ROLE_LABELS: Record<string, string> = {
  QC_LEAD: '质检组长',
  QUERY_REVIEWER: 'Query 质检',
  COPY_REVIEWER: '内容质检（文案+图片）',
};

export function ReviewPeopleManager({ users }: { users: any[] }) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState('');
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);

  async function run(key: string, action: () => Promise<unknown>, success: string) {
    setBusyKey(key);
    setMessage('');
    setIsError(false);
    try {
      await action();
      setMessage(success);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败');
      setIsError(true);
    } finally {
      setBusyKey('');
    }
  }

  function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const roles = form.getAll('roles');
    return run('create', () => apiRequest('/api/review-users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: form.get('username'),
        displayName: form.get('displayName'),
        password: form.get('password'),
        roles,
      }),
    }), '质检人员已创建，可以使用独立账号登录。');
  }

  function toggleUser(user: any) {
    const status = user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    return run(`toggle-${user.id}`, () => apiRequest(`/api/review-users/${user.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: user.displayName,
        roles: user.roles,
        status,
        expectedVersion: user.version,
      }),
    }), status === 'ACTIVE' ? '账号已启用，原会话仍需重新登录。' : '账号已停用，原会话已失效。');
  }

  return <div className="review-people-grid">
    <section className="panel review-person-create" aria-labelledby="create-reviewer-title">
      <div><span className="section-kicker">新增账号</span><h2 id="create-reviewer-title">创建质检人员</h2></div>
      <form className="stack" onSubmit={createUser}>
        <div className="field"><label htmlFor="reviewer-username">登录账号</label><input className="input" id="reviewer-username" name="username" pattern="[a-z0-9][a-z0-9._-]{2,49}" minLength={3} maxLength={50} required /></div>
        <div className="field"><label htmlFor="reviewer-display-name">显示名称</label><input className="input" id="reviewer-display-name" name="displayName" maxLength={80} required /></div>
        <div className="field"><label htmlFor="reviewer-password">初始密码</label><input className="input" id="reviewer-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={1_024} required /></div>
        <fieldset className="review-role-options"><legend>岗位角色</legend>{Object.entries(ROLE_LABELS).map(([role, label]) => <label key={role}><input type="checkbox" name="roles" value={role} />{label}</label>)}</fieldset>
        <button className="button primary" type="submit" disabled={busyKey === 'create'}>{busyKey === 'create' ? '创建中…' : '创建账号'}</button>
      </form>
    </section>
    <section className="panel review-person-list" aria-labelledby="reviewer-list-title">
      <div className="panel-head"><div><span className="section-kicker">账号目录</span><h2 id="reviewer-list-title">已配置人员</h2></div><strong>{users.length} 人</strong></div>
      <div className={`review-action-message ${isError ? 'notice error' : message ? 'notice success' : ''}`} role={isError ? 'alert' : 'status'} aria-live="polite">{message}</div>
      {users.length === 0 ? <div className="empty-state">还没有质检人员，请先创建账号。</div> : <div className="review-person-cards">{users.map((user) => <article className="review-person-card" key={user.id}>
        <div><strong>{user.displayName}</strong><span className="mono">@{user.username}</span></div>
        <div className="review-person-roles">{user.roles.map((role: string) => <span className="pill" key={role}>{ROLE_LABELS[role]}</span>)}</div>
        <div className="inline"><span className={user.status === 'ACTIVE' ? 'pill pill-approved' : 'pill'}>{user.status === 'ACTIVE' ? '已启用' : '已停用'}</span><button className="button small" type="button" disabled={busyKey === `toggle-${user.id}`} onClick={() => toggleUser(user)}>{user.status === 'ACTIVE' ? '停用' : '启用'}</button></div>
      </article>)}</div>}
    </section>
  </div>;
}
