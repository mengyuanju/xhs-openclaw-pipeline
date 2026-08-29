'use client';

import { usePathname } from 'next/navigation';

import { AppTopbar } from './app-topbar';
import { SideNav } from './side-nav';

export function AppFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/login') {
    return <main className="auth-shell">{children}</main>;
  }
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <SideNav />
      <div className="app-workspace">
        <AppTopbar />
        <main className="main-shell" id="main-content">{children}</main>
      </div>
    </div>
  );
}
