'use client';

import { LoaderCircle, LockKeyhole, LogIn, UserRound } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface LoginErrorBody {
  error?: { message?: string };
}

export function LoginForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submitLogin(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: formData.get('username'),
          password: formData.get('password'),
        }),
      });
      if (!response.ok) {
        throw new Error(await readLoginError(response));
      }
      router.replace('/');
      router.refresh();
    } catch (loginError) {
      setError(
        loginError instanceof Error ? loginError.message : '登录失败，请重试。',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-10">
      <section className="w-full max-w-[410px] overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_12px_34px_rgb(24_25_34/7%)]">
        <div className="flex items-center gap-3 border-b border-border px-6 py-5">
          <Image
            src="/favicon.png"
            alt=""
            width={44}
            height={44}
            unoptimized
            className="size-11 rounded-xl"
          />
          <div>
            <h1 className="text-lg font-medium">海默信息小红书编辑器</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">管理端登录</p>
          </div>
        </div>

        <form onSubmit={submitLogin} className="grid gap-5 p-6">
          {error ? (
            <p
              role="alert"
              className="rounded-[10px] border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          <div className="grid gap-2">
            <label htmlFor="username" className="text-sm font-medium">
              管理员账号
            </label>
            <div className="relative">
              <UserRound
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="username"
                name="username"
                autoComplete="username"
                required
                maxLength={100}
                className="h-11 bg-background pl-9"
              />
            </div>
          </div>

          <div className="grid gap-2">
            <label htmlFor="password" className="text-sm font-medium">
              密码
            </label>
            <div className="relative">
              <LockKeyhole
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={256}
                className="h-11 bg-background pl-9"
              />
            </div>
          </div>

          <Button
            type="submit"
            size="lg"
            disabled={submitting}
            className="h-11 w-full"
          >
            {submitting ? (
              <LoaderCircle className="animate-spin" data-icon="inline-start" />
            ) : (
              <LogIn data-icon="inline-start" />
            )}
            {submitting ? '正在登录…' : '登录'}
          </Button>
        </form>
      </section>
    </main>
  );
}

async function readLoginError(response: Response) {
  try {
    const body = (await response.json()) as LoginErrorBody;
    return body.error?.message || `登录失败（${response.status}）`;
  } catch {
    return `登录失败（${response.status}）`;
  }
}
