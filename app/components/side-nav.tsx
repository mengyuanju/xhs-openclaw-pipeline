'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const items = [
  { href: '/', label: '工作台', icon: '◫' },
  { href: '/imports', label: '选题导入', icon: '↥' },
  { href: '/prompts', label: '提示词', icon: '✦' },
  { href: '/tasks', label: '内容审核', icon: '✓' },
];

export function SideNav() {
  const pathname = usePathname();
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
        <span className="status-dot" /> 本机安全模式
        <small>不包含自动发布</small>
      </div>
    </aside>
  );
}
