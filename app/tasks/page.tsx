import Link from 'next/link';

import { StatusPill } from '../components/status-pill';
import { withAdminStore } from '../../src/admin/runtime.mjs';

export const dynamic = 'force-dynamic';

export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === 'string' ? params[key] as string : '';
  const result = withAdminStore((store: any) => store.listTasks({
    page: value('page') || 1,
    pageSize: 30,
    status: value('status') || undefined,
    reviewStatus: value('reviewStatus') || undefined,
    query: value('query') || undefined,
  })) as any;
  const pageHref = (page: number) => {
    const query = new URLSearchParams();
    for (const key of ['query', 'status', 'reviewStatus']) {
      if (value(key)) query.set(key, value(key));
    }
    query.set('page', String(page));
    return `/tasks?${query.toString()}`;
  };
  return <>
    <header className="page-header"><div><span className="eyebrow">Human review</span><h1>机器负责成稿，人负责定稿</h1><p className="subtle">文案和图片的每次修改都会生成新版本，通过后再次编辑会自动回到待审核。</p></div></header>
    <form className="panel form-grid filter-panel" method="get">
      <div className="field full"><label htmlFor="query">搜索选题或外部 ID</label><input className="input" id="query" name="query" defaultValue={value('query')} maxLength={500} placeholder="输入关键词" /></div>
      <div className="field"><label htmlFor="status">生成状态</label><select className="select" id="status" name="status" defaultValue={value('status')}><option value="">全部</option><option value="pending">待处理</option><option value="processing">生成中</option><option value="completed">已生成</option><option value="failed">失败</option></select></div>
      <div className="field"><label htmlFor="reviewStatus">审核状态</label><select className="select" id="reviewStatus" name="reviewStatus" defaultValue={value('reviewStatus')}><option value="">全部</option><option value="NOT_READY">未就绪</option><option value="WAITING_REVIEW">待审核</option><option value="APPROVED">已通过</option><option value="REJECTED">已驳回</option></select></div>
      <div className="field full inline"><button className="button primary" type="submit">筛选</button><Link className="button" href="/tasks">清空</Link><span className="subtle">共 {result.pagination.totalItems} 条</span></div>
    </form>
    {result.data.length === 0 ? <div className="panel empty-state">没有符合当前条件的任务。</div> : <><div className="table-wrap mobile-cards task-table-wrap"><table><thead><tr><th>ID</th><th>选题</th><th>外部 ID</th><th>图片数</th><th>生成状态</th><th>审核状态</th><th>操作</th></tr></thead><tbody>{result.data.map((task: any) => <tr key={task.id}><td className="mono" data-label="ID">#{task.id}</td><td className="query-cell" data-label="选题">{task.query}</td><td className="mono" data-label="外部 ID">{task.config?.externalId || '—'}</td><td data-label="图片数">{task.config?.imageCount || 3}</td><td data-label="生成状态"><StatusPill value={task.status} /></td><td data-label="审核状态"><StatusPill value={task.config?.reviewStatus} /></td><td className="row-action" data-label="操作"><Link className="button small" href={`/tasks/${task.id}`}>打开审核</Link></td></tr>)}</tbody></table></div><nav className="pagination" aria-label="任务分页"><span>第 {result.pagination.page} / {Math.max(1, result.pagination.totalPages)} 页</span><div className="inline">{result.pagination.page > 1 && <Link className="button small" href={pageHref(result.pagination.page - 1)}>上一页</Link>}{result.pagination.page < result.pagination.totalPages && <Link className="button small" href={pageHref(result.pagination.page + 1)}>下一页</Link>}</div></nav></>}
  </>;
}
