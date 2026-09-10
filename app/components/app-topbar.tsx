'use client';

import {
  BarChart3,
  ChevronRight,
  LayoutDashboard,
  LibraryBig,
  MessageSquareText,
  PackageSearch,
  PackageCheck,
  ShieldCheck,
  Settings2,
  ServerCog,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { WORKBENCH_VIEWS } from '../workbench/views';

type RouteMeta = {
  section: string;
  title: string;
  icon: LucideIcon;
};

const routeMeta: Array<{ match: (pathname: string) => boolean; meta: RouteMeta }> = [
  { match: (pathname) => pathname === '/workbench-statistics', meta: { section: '运营与系统', title: '作业统计', icon: BarChart3 } },
  { match: (pathname) => pathname.startsWith('/query-packages'), meta: { section: '创作工作台', title: 'Query 词包', icon: PackageSearch } },
  { match: (pathname) => pathname.startsWith('/copy-qa'), meta: { section: '质量与审核', title: '文案抽检', icon: ShieldCheck } },
  { match: (pathname) => pathname.startsWith('/delivery-pool'), meta: { section: '创作工作台', title: '交付池', icon: PackageCheck } },
  ...WORKBENCH_VIEWS.map((view) => ({
    match: (pathname: string) => pathname === view.href,
    meta: { section: '作业中心', title: view.label, icon: view.icon },
  })),
  { match: (pathname) => pathname.startsWith('/workbench'), meta: { section: '创作工作台', title: '作业中心', icon: LayoutDashboard } },
  { match: (pathname) => pathname.startsWith('/prompts'), meta: { section: '内容资产', title: '提示词版本', icon: MessageSquareText } },
  { match: (pathname) => pathname.startsWith('/knowledge'), meta: { section: '内容资产', title: '知识库', icon: LibraryBig } },
  { match: (pathname) => pathname.startsWith('/settings'), meta: { section: '运营与系统', title: '生产配置', icon: Settings2 } },
  { match: (pathname) => pathname.startsWith('/executors'), meta: { section: '运营与系统', title: '执行机管理', icon: ServerCog } },
  { match: (pathname) => pathname.startsWith('/users'), meta: { section: '运营与系统', title: '用户管理', icon: Users } },
  { match: (pathname) => pathname.startsWith('/profile'), meta: { section: '账号', title: '个人信息', icon: Users } },
];

export function AppTopbar() {
  const pathname = usePathname();
  const current = routeMeta.find((route) => route.match(pathname))?.meta ?? routeMeta[0].meta;
  const Icon = current.icon;

  return (
    <header className="app-topbar">
      <nav className="topbar-breadcrumb" aria-label="当前位置">
        <ol>
          <li className="topbar-home"><Link href="/workbench">内容工场</Link></li>
          <li className="topbar-section"><ChevronRight aria-hidden="true" size={13} /><span>{current.section}</span></li>
          <li className="topbar-title" aria-current="page">
            <ChevronRight aria-hidden="true" size={13} />
            <Icon aria-hidden="true" size={16} strokeWidth={1.9} />
            <strong>{current.title}</strong>
          </li>
        </ol>
      </nav>
    </header>
  );
}
