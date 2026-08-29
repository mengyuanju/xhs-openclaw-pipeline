'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

const items = [
  { href: '/', label: '工作台', icon: '◫' },
  { href: '/imports', label: '选题导入', icon: '↥' },
  { href: '/prompts', label: '提示词', icon: '✦' },
  { href: '/tasks', label: '内容审核', icon: '✓' },
  { href: '/analytics', label: '数据统计', icon: '▥' },
  { href: '/settings', label: '生产配置', icon: '⚙' },
  { href: '/knowledge', label: '视觉知识库', icon: '◇' },
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
            <Link
              key={item.href}
              href={item.href}
              className={active ? 'nav-item active' : 'nav-item'}
              aria-current={active ? 'page' : undefined}
            >
              <span aria-hidden="true">{item.icon}</span>{item.label}
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-foot">
        <div className="sidebar-auth-summary">
          <span className="sidebar-auth-label"><span className="status-dot" /> 局域网认证已启用</span>
          <small>单管理员 · 不包含自动发布</small>
        </div>
        <button className="sidebar-signout" type="button" onClick={signOut} disabled={isSigningOut}>
          {isSigningOut ? '正在退出…' : '退出后台'}
        </button>
        {signOutError && <span className="sidebar-error" role="alert">{signOutError}</span>}
      </div>
    </aside>
  );
}
