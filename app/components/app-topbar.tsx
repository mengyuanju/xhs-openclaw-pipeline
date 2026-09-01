'use client';

import {
  BarChart3,
  ChevronRight,
  FilePenLine,
  FileUp,
  LayoutDashboard,
  ImagePlus,
  LibraryBig,
  ListChecks,
  MessageSquareText,
  ClipboardCheck,
  Plus,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Button } from '@/components/ui/button';

type RouteMeta = {
  section: string;
  title: string;
  icon: LucideIcon;
};

const routeMeta: Array<{ match: (pathname: string) => boolean; meta: RouteMeta }> = [
  { match: (pathname) => pathname === '/', meta: { section: '总览', title: '工作台', icon: LayoutDashboard } },
  { match: (pathname) => pathname.startsWith('/imports'), meta: { section: '内容生产', title: '选题导入', icon: FileUp } },
  { match: (pathname) => pathname.startsWith('/copy-generation'), meta: { section: '内容生产', title: '单独生成文案', icon: FilePenLine } },
  { match: (pathname) => pathname.startsWith('/image-generation'), meta: { section: '内容生产', title: '单独生成图片', icon: ImagePlus } },
  { match: (pathname) => /^\/tasks\/\d+/.test(pathname), meta: { section: '内容生产', title: '任务详情', icon: ListChecks } },
  { match: (pathname) => pathname.startsWith('/tasks'), meta: { section: '内容生产', title: '任务中心', icon: ListChecks } },
  { match: (pathname) => pathname.startsWith('/prompts'), meta: { section: '内容资产', title: '提示词版本', icon: MessageSquareText } },
  { match: (pathname) => pathname.startsWith('/knowledge'), meta: { section: '内容资产', title: '知识库', icon: LibraryBig } },
  { match: (pathname) => pathname.startsWith('/analytics'), meta: { section: '运营与系统', title: '数据统计', icon: BarChart3 } },
  { match: (pathname) => pathname.startsWith('/settings'), meta: { section: '运营与系统', title: '生产配置', icon: Settings2 } },
  { match: (pathname) => pathname.startsWith('/reviews'), meta: { section: '质检作业', title: '质检中心', icon: ClipboardCheck } },
];

export function AppTopbar({ session }: { session: { roles?: string[] } | null }) {
  const pathname = usePathname();
  const current = routeMeta.find((route) => route.match(pathname))?.meta ?? routeMeta[0].meta;
  const Icon = current.icon;
  const isAdmin = session?.roles?.includes('ADMIN') === true;

  return (
    <header className="app-topbar">
      <div className="topbar-context">
        <nav className="topbar-breadcrumb" aria-label="当前位置">
          <span>内容工场</span>
          <ChevronRight aria-hidden="true" size={13} strokeWidth={1.8} />
          <span>{current.section}</span>
        </nav>
        <div className="topbar-title">
          <Icon aria-hidden="true" size={17} strokeWidth={1.9} />
          <strong>{current.title}</strong>
        </div>
      </div>
      <div className="topbar-actions">
        <span className="workspace-mode"><ShieldCheck aria-hidden="true" size={14} /> 本地工作区</span>
        {isAdmin && <Button asChild size="sm" className="topbar-primary-action">
          <Link href="/imports"><Plus aria-hidden="true" size={15} />导入选题</Link>
        </Button>}
      </div>
    </header>
  );
}
