'use client';

import { useState, type FormEvent } from 'react';

import { apiRequest } from '../components/api-client';

export function LoginForm({ nextPath }: { nextPath: string }) {
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const result = await apiRequest<{ homePath: string }>('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
      });
      const safeNext = nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : result.homePath;
      const target = result.homePath === '/reviews' && !safeNext.startsWith('/reviews')
        ? '/reviews'
        : safeNext;
      window.location.assign(target);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '登录失败');
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <form className="login-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="account-username">账号</label>
        <input
          className="input login-input"
          id="account-username"
          name="username"
          type="text"
          autoComplete="username"
          minLength={3}
          maxLength={50}
          defaultValue="admin"
          required
          autoFocus
        />
      </div>
      <div className="field">
        <label htmlFor="account-password">密码</label>
        <input
          className="input login-input"
          id="account-password"
          name="password"
          type="password"
          autoComplete="current-password"
          minLength={12}
          maxLength={1_024}
          required
        />
      </div>
      {error && <div className="notice error" role="alert">{error}</div>}
      <button className="button primary login-submit" type="submit" disabled={isBusy}>
        {isBusy ? '正在验证…' : '进入后台'}
      </button>
      <p className="login-help">系统管理员账号为 <code>admin</code>；首次使用请在主机终端运行 <code>npm run auth:setup</code>。</p>
    </form>
  );
}
