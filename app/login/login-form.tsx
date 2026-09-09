'use client';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

import { useState, type FormEvent } from 'react';

import { apiRequest } from '../components/api-client';

export function LoginForm({ nextPath, passwordChanged = false }: { nextPath: string; passwordChanged?: boolean }) {
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const result = await apiRequest<{ homePath: string; role: string; mustChangePassword: boolean }>('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
      });
      const requested = nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : result.homePath;
      const permitted = result.role === 'ADMIN'
        || requested === '/profile'
        || requested.startsWith('/workbench')
        || (result.role === 'REVIEWER' && requested.startsWith('/knowledge'));
      const target = result.mustChangePassword ? '/profile' : permitted ? requested : result.homePath;
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
        <Input
          className="input login-input"
          id="account-username"
          name="username"
          type="text"
          autoComplete="username"
          minLength={3}
          maxLength={50}
          required
          autoFocus
        />
      </div>
      <div className="field">
        <label htmlFor="account-password">密码</label>
        <Input
          className="input login-input"
          id="account-password"
          name="password"
          type="password"
          autoComplete="current-password"
          minLength={6}
          maxLength={1_024}
          required
        />
      </div>
      {passwordChanged && <div className="notice success" role="status">密码已修改，请使用新密码重新登录。</div>}
      {error && <div className="notice error" role="alert">{error}</div>}
      <Button unstyled className="button primary login-submit" type="submit" disabled={isBusy}>
        {isBusy ? '正在验证…' : '进入后台'}
      </Button>
      <p className="login-help">初始管理员账号为 <code>admin</code>，默认密码为 <code>123456</code>。首次登录必须先修改密码，重新登录后才能使用其他功能。</p>
    </form>
  );
}
