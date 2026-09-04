'use client';

import {
  BarChart3,
  ChevronRight,
  FilePenLine,
  FileUp,
  LayoutDashboard,
  ImagePlus,
  Images,
  Layers3,
  LibraryBig,
  ListChecks,
  MessageSquareText,
  ClipboardCheck,
  Settings2,
  Waypoints,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type RouteMeta = {
  section: string;
  title: string;
  icon: LucideIcon;
};

const routeMeta: Array<{ match: (pathname: string) => boolean; meta: RouteMeta }> = [
  { match: (pathname) => pathname.startsWith('/workbench'), meta: { section: '创作工作台', title: '作业中心', icon: LayoutDashboard } },
  { match: (pathname) => pathname === '/', meta: { section: '创作工作台', title: '历史工作台', icon: LayoutDashboard } },
  { match: (pathname) => pathname.startsWith('/jobs'), meta: { section: '内容生产', title: '远端作业中心', icon: Workflow } },
  { match: (pathname) => pathname.startsWith('/imports'), meta: { section: '内容生产', title: '选题导入', icon: FileUp } },
  { match: (pathname) => pathname.startsWith('/copy-generation'), meta: { section: '内容生产', title: '单独生成文案', icon: FilePenLine } },
  { match: (pathname) => pathname.startsWith('/batch-copy-generation'), meta: { section: '内容生产', title: '批量生成文案', icon: Layers3 } },
  { match: (pathname) => pathname.startsWith('/image-generation'), meta: { section: '内容生产', title: '单独生成图片', icon: ImagePlus } },
  { match: (pathname) => pathname.startsWith('/batch-image-generation'), meta: { section: '内容生产', title: '批量生成图片', icon: Images } },
  { match: (pathname) => /^\/tasks\/\d+/.test(pathname), meta: { section: '内容生产', title: '任务详情', icon: ListChecks } },
  { match: (pathname) => pathname.startsWith('/tasks'), meta: { section: '内容生产', title: '任务中心', icon: ListChecks } },
  { match: (pathname) => pathname.startsWith('/prompts'), meta: { section: '内容资产', title: '提示词版本', icon: MessageSquareText } },
  { match: (pathname) => pathname.startsWith('/knowledge'), meta: { section: '内容资产', title: '知识库', icon: LibraryBig } },
  { match: (pathname) => pathname.startsWith('/analytics'), meta: { section: '运营与系统', title: '数据统计', icon: BarChart3 } },
  { match: (pathname) => pathname.startsWith('/openclaw-traces'), meta: { section: '运营与系统', title: '模型链路', icon: Waypoints } },
  { match: (pathname) => pathname.startsWith('/settings'), meta: { section: '运营与系统', title: '生产配置', icon: Settings2 } },
  { match: (pathname) => pathname.startsWith('/reviews/people'), meta: { section: '质检作业', title: '质检人员', icon: ClipboardCheck } },
  { match: (pathname) => pathname.startsWith('/reviews'), meta: { section: '质检作业', title: '质检中心', icon: ClipboardCheck } },
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
