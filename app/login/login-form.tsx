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
      await apiRequest('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: form.get('password') }),
      });
      const target = nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : '/';
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
        <label htmlFor="admin-password">管理员密码</label>
        <input
          className="input login-input"
          id="admin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          minLength={12}
          maxLength={1_024}
          required
          autoFocus
        />
      </div>
      {error && <div className="notice error" role="alert">{error}</div>}
      <button className="button primary login-submit" type="submit" disabled={isBusy}>
        {isBusy ? '正在验证…' : '进入后台'}
      </button>
      <p className="login-help">密码未配置时，请先在主机终端运行 <code>npm run auth:setup</code>。</p>
    </form>
  );
}
