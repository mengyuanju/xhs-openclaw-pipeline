'use client';

import type { ReactNode } from 'react';
import { ListChecks, ShieldCheck, UserCheck, Users } from 'lucide-react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type UserManagementOverview = {
  totalUsers: number;
  activeUsers: number;
  autoAssignableTasks: number;
  availableWorkers: number;
  poolMembers: number;
  assignmentEnabled: boolean;
};

export function UserManagementWorkspace({
  overview,
  accountManager,
  assignmentManager,
}: {
  overview: UserManagementOverview;
  accountManager: ReactNode;
  assignmentManager: ReactNode;
}) {
  return <div className="user-management-workspace">
    <section className="user-overview-strip" aria-label="用户管理概览">
      <div className="user-overview-item">
        <span className="user-overview-icon"><Users size={17} /></span>
        <span><small>全部用户</small><strong>{overview.totalUsers}</strong></span>
      </div>
      <div className="user-overview-item is-positive">
        <span className="user-overview-icon"><UserCheck size={17} /></span>
        <span><small>启用账号</small><strong>{overview.activeUsers}</strong></span>
      </div>
      <div className="user-overview-item">
        <span className="user-overview-icon"><ListChecks size={17} /></span>
        <span><small>待分配任务</small><strong>{overview.autoAssignableTasks}</strong></span>
      </div>
      <div className="user-overview-item is-positive">
        <span className="user-overview-icon"><ShieldCheck size={17} /></span>
        <span><small>可用池成员</small><strong>{overview.availableWorkers}</strong></span>
      </div>
      <span className={`user-assignment-state ${overview.assignmentEnabled ? 'is-on' : ''}`}>
        <i aria-hidden="true" />自动分配{overview.assignmentEnabled ? '已开启' : '已关闭'}
      </span>
    </section>

    <Tabs className="user-management-tabs" defaultValue="accounts">
      <div className="user-management-tab-bar">
        <TabsList className="user-management-tab-list" aria-label="用户管理功能">
          <TabsTrigger value="accounts">
            <Users size={16} />账号与权限
            <span className="user-tab-count">{overview.totalUsers}</span>
          </TabsTrigger>
          <TabsTrigger value="assignment">
            <ListChecks size={16} />自动分配池
            <span className="user-tab-count">{overview.poolMembers}</span>
          </TabsTrigger>
        </TabsList>
        <p>按管理任务切换，页面仅展示当前需要操作的内容。</p>
      </div>
      <TabsContent value="accounts">{accountManager}</TabsContent>
      <TabsContent value="assignment">{assignmentManager}</TabsContent>
    </Tabs>
  </div>;
}
