'use client';

import { CheckCircle2, KeyRound, LockKeyhole, ShieldCheck, UserRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { apiRequest } from '../components/api-client';

const ROLE_LABELS: Record<string, string> = { ADMIN: '管理员', REVIEWER: '审核员', USER: '普通用户' };

type ProfileUser = {
  username: string;
  displayName: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  version: number;
};

export function ProfileManager({ user }: { user: ProfileUser }) {
  const router = useRouter();
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy('profile');
    setNotice('');
    setError('');
    try {
      await apiRequest('/api/control-plane/v1/profile', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: form.get('displayName'), expectedVersion: user.version }),
      });
      setNotice('个人信息已更新。');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '更新失败');
    } finally {
      setBusy('');
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = String(form.get('newPassword') || '');
    if (next !== form.get('confirmPassword')) {
      setNotice('');
      setError('两次输入的新密码不一致');
      return;
    }
    setBusy('password');
    setNotice('');
    setError('');
    try {
      await apiRequest('/api/control-plane/v1/profile/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: form.get('currentPassword'), newPassword: next }),
      });
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.assign('/login?reauth=1');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '密码修改失败');
      setBusy('');
    }
  }

  return <div className="profile-layout">
    <aside className="panel profile-summary-card">
      <div className="profile-avatar" aria-hidden="true">{[...user.displayName][0]?.toUpperCase() || '?'}</div>
      <div className="profile-identity"><h2>{user.displayName}</h2><span className="mono">@{user.username}</span><span className="pill profile-role-pill"><ShieldCheck size={13} />{ROLE_LABELS[user.role] || user.role}</span></div>
      <dl className="profile-facts">
        <div><dt>登录账号</dt><dd>{user.username}</dd></div>
        <div><dt>账号角色</dt><dd>{ROLE_LABELS[user.role] || user.role}</dd></div>
        <div><dt>账号状态</dt><dd><span className="profile-status-dot" />{user.status === 'ACTIVE' ? '正常启用' : '已停用'}</dd></div>
      </dl>
      <p className="profile-summary-note"><LockKeyhole size={15} />账号和角色由管理员统一维护。如需调整，请联系管理员。</p>
    </aside>

    <div className="profile-content-stack">
      {(notice || error) && <div className={`notice ${error ? 'error' : 'success'} profile-notice`} role={error ? 'alert' : 'status'}>{error || notice}</div>}

      <section className="panel profile-section" aria-labelledby="basic-profile-title">
        <div className="profile-section-head"><span><UserRound size={19} /></span><div><h2 id="basic-profile-title">基本资料</h2><p>这里的姓名会显示在任务和操作记录中。</p></div></div>
        <form className="profile-form" onSubmit={saveProfile}>
          <div className="field"><label htmlFor="profile-name">显示姓名</label><input className="input" id="profile-name" name="displayName" defaultValue={user.displayName} maxLength={80} required /><small>最多 80 个字符，建议使用便于团队识别的真实姓名或昵称。</small></div>
          <div className="profile-form-actions"><span>{notice ? <><CheckCircle2 size={14} />已保存最新资料</> : '修改后点击保存即可生效'}</span><button className="button primary" disabled={Boolean(busy)}>{busy === 'profile' ? '保存中…' : '保存资料'}</button></div>
        </form>
      </section>

      <section className="panel profile-section" aria-labelledby="password-title">
        <div className="profile-section-head"><span><KeyRound size={19} /></span><div><h2 id="password-title">登录密码</h2><p>更新密码后，当前会话将退出，需要使用新密码重新登录。</p></div></div>
        {user.mustChangePassword && <div className="notice profile-password-warning"><LockKeyhole size={16} /><span><strong>当前仍在使用初始密码</strong>请尽快设置只有你知道的新密码。</span></div>}
        <form className="profile-form" onSubmit={changePassword}>
          <div className="field"><label htmlFor="current-password">当前密码</label><input className="input" id="current-password" name="currentPassword" type="password" autoComplete="current-password" minLength={6} required /></div>
          <div className="profile-password-grid">
            <div className="field"><label htmlFor="new-password">新密码</label><input className="input" id="new-password" name="newPassword" type="password" autoComplete="new-password" minLength={6} maxLength={1024} required /><small>至少 6 个字符。</small></div>
            <div className="field"><label htmlFor="confirm-password">确认新密码</label><input className="input" id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={6} required /></div>
          </div>
          <div className="profile-form-actions"><span>请勿与其他平台共用同一密码</span><button className="button primary" disabled={Boolean(busy)}>{busy === 'password' ? '修改中…' : '修改密码'}</button></div>
        </form>
      </section>
    </div>
  </div>;
}
