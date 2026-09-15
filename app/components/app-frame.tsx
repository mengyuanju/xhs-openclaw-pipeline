'use client';

import { usePathname } from 'next/navigation';
import { useRef } from 'react';

import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog';
import { TextInputDialogProvider } from '@/components/ui/text-input-dialog';

import { AppTopbar } from './app-topbar';
import { SideNav } from './side-nav';
import { XhsAccountAlert } from './xhs-account-alert';

type ShellSession = {
  subject: string;
  username?: string;
  roles?: string[];
  copyReviewEnabled?: boolean;
  copyQcEnabled?: boolean;
  imageQcEnabled?: boolean;
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
        <XhsAccountAlert enabled={session?.roles?.includes('ADMIN') === true} />
        <div className="app-shell">
          <a className="skip-link" href="#main-content" onClick={() => {
            window.requestAnimationFrame(() => mainRef.current?.focus());
          }}>跳到主要内容</a>
          <SideNav session={session} />
          <div className="app-workspace">
            <AppTopbar />
            <main className="main-shell" id="main-content" ref={mainRef} tabIndex={-1}>{children}</main>
          </div>
        </div>
      </TextInputDialogProvider>
    </ConfirmDialogProvider>
  );
}
