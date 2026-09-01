'use client';

import { usePathname } from 'next/navigation';

import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog';

import { AppTopbar } from './app-topbar';
import { SideNav } from './side-nav';

type ShellSession = { subject: string; username?: string; roles?: string[] } | null;

export function AppFrame({ children, session }: { children: React.ReactNode; session: ShellSession }) {
  const pathname = usePathname();
  if (pathname === '/login') {
    return <ConfirmDialogProvider><main className="auth-shell">{children}</main></ConfirmDialogProvider>;
  }
  return (
    <ConfirmDialogProvider>
      <div className="app-shell">
        <a className="skip-link" href="#main-content">跳到主要内容</a>
        <SideNav session={session} />
        <div className="app-workspace">
          <AppTopbar session={session} />
          <main className="main-shell" id="main-content">{children}</main>
        </div>
      </div>
    </ConfirmDialogProvider>
  );
}
