'use client';

import {
  BarChart3,
  ChevronDown,
  FilePenLine,
  FileUp,
  LayoutDashboard,
  ImagePlus,
  Images,
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
  Workflow,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { WORKBENCH_VIEWS } from '../workbench/views';

type NavigationItem = { href: string; label: string; icon: LucideIcon; children?: NavigationItem[]; hidden?: boolean };
type NavigationGroup = { label: string; items: NavigationItem[]; hidden?: boolean };

// Temporary presentation flags only: keep routes and their access rules unchanged.
const navigationGroups: NavigationGroup[] = [
  { label: '创作工作台', items: [{ href: '/workbench', label: '作业中心', icon: LayoutDashboard, children: WORKBENCH_VIEWS }] },
  {
    label: '内容生产',
    hidden: true,
    items: [
      { href: '/jobs', label: '远端作业中心', icon: Workflow },
      { href: '/imports', label: '选题导入', icon: FileUp },
      { href: '/copy-generation', label: '单独生成文案', icon: FilePenLine },
      { href: '/batch-copy-generation', label: '批量生成文案', icon: Layers3 },
      { href: '/image-generation', label: '单独生成图片', icon: ImagePlus },
      { href: '/batch-image-generation', label: '批量生成图片', icon: Images },
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
      { href: '/analytics', label: '数据统计', icon: BarChart3, hidden: true },
      { href: '/openclaw-traces', label: '模型链路', icon: Waypoints, hidden: true },
      { href: '/settings', label: '生产配置', icon: Settings2 },
    ],
  },
];

const reviewNavigation: NavigationGroup[] = [{
  label: '质检作业',
  hidden: true,
  items: [
    { href: '/reviews', label: '质检中心', icon: ClipboardCheck },
    { href: '/reviews/people', label: '质检人员', icon: Users },
  ],
}];

export function SideNav({ session }: { session: { subject: string; username?: string; roles?: string[] } | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isWorkbenchOpen, setIsWorkbenchOpen] = useState(pathname.startsWith('/workbench'));
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const isAdmin = session?.roles?.includes('ADMIN') === true;
  const roleGroups = isAdmin
    ? [...navigationGroups.slice(0, 2), ...reviewNavigation, ...navigationGroups.slice(2)]
    : reviewNavigation.map((group) => ({ ...group, items: group.items.filter((item) => item.href === '/reviews') }));
  const visibleGroups = roleGroups.filter((group) => !group.hidden)
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.hidden) }))
    .filter((group) => group.items.length > 0);

  useEffect(() => setIsMenuOpen(false), [pathname]);
  useEffect(() => {
    if (pathname.startsWith('/workbench')) setIsWorkbenchOpen(true);
  }, [pathname]);

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
        <Link className="brand" href="/workbench" aria-label="内容工场作业中心">
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
                if (item.children) return <div className="nav-item-group" key={item.href}>
                  <button
                    className="nav-item nav-parent"
                    type="button"
                    aria-expanded={isWorkbenchOpen}
                    aria-controls="workbench-submenu"
                    onClick={() => setIsWorkbenchOpen((open) => !open)}
                  >
                    <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
                    <span>{item.label}</span>
                    <ChevronDown aria-hidden="true" size={14} className="nav-parent-chevron" />
                  </button>
                  <div className="nav-submenu" id="workbench-submenu" hidden={!isWorkbenchOpen}>
                    {item.children.map((child) => {
                      const ChildIcon = child.icon;
                      const selected = pathname === child.href;
                      return <Link key={child.href} href={child.href}
                        className={selected ? 'nav-item active' : 'nav-item'}
                        aria-current={selected ? 'page' : undefined}>
                        <ChildIcon aria-hidden="true" size={15} strokeWidth={1.8} />
                        <span>{child.label}</span>
                      </Link>;
                    })}
                  </div>
                </div>;
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
