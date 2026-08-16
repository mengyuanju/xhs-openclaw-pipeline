'use client';

import { usePathname } from 'next/navigation';

import { SideNav } from './side-nav';

export function AppFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/login') {
    return <main className="auth-shell">{children}</main>;
  }
  return (
    <div className="app-shell">
      <SideNav />
      <main className="main-shell">{children}</main>
    </div>
  );
}
