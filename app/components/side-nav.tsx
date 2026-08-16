'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

const items = [
  { href: '/', label: '工作台', icon: '◫' },
  { href: '/imports', label: '选题导入', icon: '↥' },
  { href: '/prompts', label: '提示词', icon: '✦' },
  { href: '/tasks', label: '内容审核', icon: '✓' },
];

export function SideNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');

  async function signOut() {
    setIsSigningOut(true);
    setSignOutError('');
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok && response.status !== 401) throw new Error('退出请求失败');
      router.replace('/login');
      router.refresh();
    } catch {
      setSignOutError('退出失败，请重试');
      setIsSigningOut(false);
    }
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">RED</span>
        <div><strong>内容工场</strong><small>OpenClaw Console</small></div>
      </div>
      <nav className="nav-list" aria-label="主导航">
        {items.map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className={active ? 'nav-item active' : 'nav-item'}>
              <span aria-hidden="true">{item.icon}</span>{item.label}
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-foot">
        <span className="status-dot" /> 局域网认证已启用
        <small>单管理员 · 不包含自动发布</small>
        <button className="sidebar-signout" type="button" onClick={signOut} disabled={isSigningOut}>
          {isSigningOut ? '正在退出…' : '退出后台'}
        </button>
        {signOutError && <span className="sidebar-error" role="alert">{signOutError}</span>}
      </div>
    </aside>
  );
}
