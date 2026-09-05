'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../components/api-client';

const ROLE_LABELS: Record<string, string> = { ADMIN: '管理员', REVIEWER: '审核员', USER: '普通用户' };

export function ProfileManager({ user }: { user: any }) {
  const router = useRouter();
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    setBusy('profile'); setNotice(''); setError('');
    try {
      await apiRequest('/api/control-plane/v1/profile', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: form.get('displayName'), expectedVersion: user.version }) });
      setNotice('个人信息已更新。'); router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '更新失败'); }
    finally { setBusy(''); }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const next = String(form.get('newPassword') || '');
    if (next !== form.get('confirmPassword')) { setError('两次输入的新密码不一致'); return; }
    setBusy('password'); setNotice(''); setError('');
    try {
      await apiRequest('/api/control-plane/v1/profile/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: form.get('currentPassword'), newPassword: next }) });
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.assign('/login?reauth=1');
    } catch (caught) { setError(caught instanceof Error ? caught.message : '密码修改失败'); setBusy(''); }
  }

  return <div className="settings-grid">
    <section className="panel"><h2>基本资料</h2><form className="stack" onSubmit={saveProfile}><div className="field"><label>账号</label><input className="input" value={user.username} disabled /></div><div className="field"><label>角色</label><input className="input" value={ROLE_LABELS[user.role]} disabled /></div><div className="field"><label htmlFor="profile-name">姓名</label><input className="input" id="profile-name" name="displayName" defaultValue={user.displayName} maxLength={80} required /></div><button className="button primary" disabled={busy === 'profile'}>保存资料</button></form></section>
    <section className="panel"><h2>修改密码</h2>{user.mustChangePassword && <div className="notice">当前仍为初始密码，请尽快修改。</div>}<form className="stack" onSubmit={changePassword}><div className="field"><label htmlFor="current-password">当前密码</label><input className="input" id="current-password" name="currentPassword" type="password" minLength={6} required /></div><div className="field"><label htmlFor="new-password">新密码</label><input className="input" id="new-password" name="newPassword" type="password" minLength={6} maxLength={1024} required /></div><div className="field"><label htmlFor="confirm-password">确认新密码</label><input className="input" id="confirm-password" name="confirmPassword" type="password" minLength={6} required /></div><button className="button primary" disabled={busy === 'password'}>修改密码</button></form></section>
    {notice && <div className="notice success" role="status">{notice}</div>}{error && <div className="notice error" role="alert">{error}</div>}
  </div>;
}
