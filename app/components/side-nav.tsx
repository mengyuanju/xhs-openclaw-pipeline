'use client';

import {
  BarChart3,
  FilePenLine,
  FileUp,
  LayoutDashboard,
  ImagePlus,
  Layers3,
  LibraryBig,
  ListChecks,
  ClipboardCheck,
  LogOut,
  Menu,
  MessageSquareText,
  Settings2,
  Users,
  Waypoints,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type NavigationItem = { href: string; label: string; icon: LucideIcon };

const navigationGroups: Array<{ label: string; items: NavigationItem[] }> = [
  { label: '总览', items: [{ href: '/', label: '工作台', icon: LayoutDashboard }] },
  {
    label: '内容生产',
    items: [
      { href: '/imports', label: '选题导入', icon: FileUp },
      { href: '/copy-generation', label: '单独生成文案', icon: FilePenLine },
      { href: '/image-generation', label: '单独生成图片', icon: ImagePlus },
      { href: '/batch-generation', label: '批量生成图文', icon: Layers3 },
      { href: '/tasks', label: '任务中心', icon: ListChecks },
    ],
  },
  {
    label: '内容资产',
    items: [
      { href: '/prompts', label: '提示词版本', icon: MessageSquareText },
      { href: '/knowledge', label: '知识库', icon: LibraryBig },
    ],
  },
  {
    label: '运营与系统',
    items: [
      { href: '/analytics', label: '数据统计', icon: BarChart3 },
      { href: '/openclaw-traces', label: '模型链路', icon: Waypoints },
      { href: '/settings', label: '生产配置', icon: Settings2 },
    ],
  },
];

const reviewNavigation: Array<{ label: string; items: NavigationItem[] }> = [{
  label: '质检作业',
  items: [
    { href: '/reviews', label: '质检中心', icon: ClipboardCheck },
    { href: '/reviews/people', label: '质检人员', icon: Users },
  ],
}];

export function SideNav({ session }: { session: { subject: string; username?: string; roles?: string[] } | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const isAdmin = session?.roles?.includes('ADMIN') === true;
  const visibleGroups = isAdmin
    ? [...navigationGroups.slice(0, 2), ...reviewNavigation, ...navigationGroups.slice(2)]
    : reviewNavigation.map((group) => ({ ...group, items: group.items.filter((item) => item.href === '/reviews') }));

  useEffect(() => setIsMenuOpen(false), [pathname]);

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
      <div className="sidebar-head">
        <Link className="brand" href="/" aria-label="内容工场工作台">
          <span className="brand-mark">RED</span>
          <div><strong>内容工场</strong><small>OpenClaw Console</small></div>
        </Link>
        <button
          className="mobile-nav-toggle"
          type="button"
          aria-label="切换主导航"
          aria-controls="primary-navigation"
          aria-expanded={isMenuOpen}
          onClick={() => setIsMenuOpen((open) => !open)}
        >
          {isMenuOpen ? <X aria-hidden="true" size={19} /> : <Menu aria-hidden="true" size={19} />}
        </button>
      </div>
      <nav className="nav-list" id="primary-navigation" data-open={isMenuOpen} aria-label="主导航">
        {visibleGroups.map((group) => (
          <div className="nav-group" key={group.label}>
            <span className="nav-group-label">{group.label}</span>
            <div className="nav-group-items">
              {group.items.map((item) => {
                const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={active ? 'nav-item active' : 'nav-item'}
                    aria-current={active ? 'page' : undefined}
                  >
                    <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        <div className="sidebar-auth-summary">
          <span className="sidebar-auth-label"><span className="status-dot" /> 局域网认证已启用</span>
          <small>{isAdmin ? '系统管理员' : `质检账号 · ${session?.username || '未识别'}`}</small>
        </div>
        <button className="sidebar-signout" type="button" onClick={signOut} disabled={isSigningOut}>
          <LogOut aria-hidden="true" size={14} />
          {isSigningOut ? '正在退出…' : '退出后台'}
        </button>
        {signOutError && <span className="sidebar-error" role="alert">{signOutError}</span>}
      </div>
    </aside>
  );
}
