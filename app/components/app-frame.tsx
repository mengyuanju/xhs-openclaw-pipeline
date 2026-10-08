'use client';

import { usePathname } from 'next/navigation';
import { useRef } from 'react';

import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog';
import { TextInputDialogProvider } from '@/components/ui/text-input-dialog';

import { AppTopbar } from './app-topbar';
import { SideNav } from './side-nav';
import { XhsAccountAlert } from './xhs-account-alert';
import { BackgroundTasksProvider } from './background-tasks';
import { SessionKeeper } from './session-keeper';

type ShellSession = {
  subject: string;
  userId?: number;
  username?: string;
  roles?: string[];
  copyReviewEnabled?: boolean;
  copyQcEnabled?: boolean;
  imageQcEnabled?: boolean;
  sessionId?: string;
  expiresAt?: number;
  absoluteExpiresAt?: number;
  serverTime?: number;
} | null;

export function AppFrame({ children, session }: { children: React.ReactNode; session: ShellSession }) {
  const pathname = usePathname();
  const mainRef = useRef<HTMLElement>(null);
  if (pathname === '/login') {
    return <ConfirmDialogProvider><TextInputDialogProvider><main className="auth-shell">{children}</main></TextInputDialogProvider></ConfirmDialogProvider>;
  }
  return (
    <ConfirmDialogProvider>
      <TextInputDialogProvider>
        {session?.sessionId && session.expiresAt && session.absoluteExpiresAt && <SessionKeeper session={{
          sessionId: session.sessionId, userId: session.userId ?? null, expiresAt: session.expiresAt,
          absoluteExpiresAt: session.absoluteExpiresAt, renewable: session.subject === 'user',
          serverTime: session.serverTime,
        }} />}
        <BackgroundTasksProvider key={`${session?.subject}:${session?.userId}:${session?.username}`} accountKey={`${session?.subject}:${session?.userId}:${session?.username}`}
          accountUsername={session?.username ?? (session?.subject === 'admin' ? 'admin' : '')} accountId={session?.userId ?? 0}>
          <XhsAccountAlert enabled={session?.roles?.includes('ADMIN') === true} deferInitialRead={pathname === '/executors'} />
          <div className="app-shell" data-work-mode={pathname === '/work-mode' || undefined}>
            <a className="skip-link" href="#main-content" onClick={() => {
              window.requestAnimationFrame(() => mainRef.current?.focus());
            }}>跳到主要内容</a>
            <SideNav session={session} />
            <div className="app-workspace">
              <AppTopbar />
              <main className="main-shell" id="main-content" ref={mainRef} tabIndex={-1}>{children}</main>
            </div>
          </div>
        </BackgroundTasksProvider>
      </TextInputDialogProvider>
    </ConfirmDialogProvider>
  );
}
