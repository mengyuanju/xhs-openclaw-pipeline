import Link from 'next/link';

import { StatusPill } from '../components/status-pill';
import { TaskProgressRefresh } from '../components/task-progress-refresh';
import { TaskTiming } from '../components/task-timing';
import { TaskBatchExportForm } from './task-batch-export-form';
import { withAdminStore } from '../../src/admin/runtime.mjs';
import { getTaskExportAvailability } from '../../src/admin/task-export.mjs';

export const dynamic = 'force-dynamic';

export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === 'string' ? params[key] as string : '';
  const requestedBatchId = Number(value('batchId'));
  const { result, timingStats, batches, selectedBatchId } = withAdminStore((store: any) => {
    const batches = store.listImportBatches({
      page: 1,
      pageSize: 100,
      status: 'COMMITTED',
    }).data.filter((batch: any) => batch.statistics.taskCount > 0);
    const selectedBatchId = Number.isInteger(requestedBatchId)
      && requestedBatchId > 0
      && batches.some((batch: any) => batch.id === requestedBatchId)
      ? requestedBatchId
      : batches[0]?.id ?? null;
    const taskPage = store.listTasks({
      page: value('page') || 1,
      pageSize: 30,
      importBatchId: selectedBatchId ?? Number.MAX_SAFE_INTEGER,
      status: value('status') || undefined,
      reviewStatus: value('reviewStatus') || undefined,
      query: value('query') || undefined,
    });
    return {
      result: {
        ...taskPage,
        data: taskPage.data.map((task: any) => ({
          ...task,
          exportAvailability: getTaskExportAvailability(task),
        })),
      },
      timingStats: store.getTaskTimingStats(),
      batches,
      selectedBatchId,
    };
  }) as any;
  const exportableCount = result.data.filter((task: any) => task.exportAvailability.canExport).length;
  const clearHref = selectedBatchId ? `/tasks?batchId=${selectedBatchId}` : '/tasks';
  const pageHref = (page: number) => {
    const query = new URLSearchParams();
    if (selectedBatchId) query.set('batchId', String(selectedBatchId));
    for (const key of ['query', 'status', 'reviewStatus']) {
      if (value(key)) query.set(key, value(key));
    }
    query.set('page', String(page));
    return `/tasks?${query.toString()}`;
  };
  return <>
    <header className="page-header"><div><span className="eyebrow">Human review</span><h1 className="sr-only">内容审核</h1><p className="subtle">文案和图片的每次修改都会生成新版本，通过后再次编辑会自动回到待审核。</p></div><TaskProgressRefresh active={result.data.some((task: any) => task.status === 'pending' || task.status === 'processing')} /></header>
    <form className="panel form-grid filter-panel" method="get">
      <div className="field full"><label htmlFor="batchId">任务批次</label><select className="select" id="batchId" name="batchId" defaultValue={selectedBatchId ? String(selectedBatchId) : ''} disabled={batches.length === 0}>{batches.length === 0 ? <option value="">暂无已入队任务</option> : batches.map((batch: any) => <option key={batch.id} value={batch.id}>{batch.name}（{batch.statistics.taskCount} 条）</option>)}</select></div>
      <div className="field full"><label htmlFor="query">搜索选题或外部 ID</label><input className="input" id="query" name="query" defaultValue={value('query')} maxLength={500} placeholder="输入关键词" /></div>
      <div className="field"><label htmlFor="status">生成状态</label><select className="select" id="status" name="status" defaultValue={value('status')}><option value="">全部</option><option value="pending">待处理</option><option value="processing">生成中</option><option value="completed">已生成</option><option value="failed">失败</option></select></div>
      <div className="field"><label htmlFor="reviewStatus">审核状态</label><select className="select" id="reviewStatus" name="reviewStatus" defaultValue={value('reviewStatus')}><option value="">全部</option><option value="NOT_READY">未就绪</option><option value="WAITING_REVIEW">待审核</option><option value="APPROVED">已通过</option><option value="REJECTED">已驳回</option></select></div>
      <div className="field full inline"><button className="button primary" type="submit" disabled={batches.length === 0}>筛选</button><Link className="button" href={clearHref}>清空</Link><span className="subtle">当前批次共 {result.pagination.totalItems} 条</span></div>
    </form>
    {result.data.length === 0 ? <div className="panel empty-state">没有符合当前条件的任务。</div> : <TaskBatchExportForm exportableCount={exportableCount}><div className="table-wrap mobile-cards task-table-wrap"><table><thead><tr><th>选择</th><th>ID</th><th>选题</th><th>外部 ID</th><th>图片数</th><th>生成状态</th><th>耗时</th><th>审核状态</th><th>操作</th></tr></thead><tbody>{result.data.map((task: any) => <tr key={task.id}><td data-label="选择"><input className="task-select" type="checkbox" name="taskId" value={task.id} aria-label={`选择任务 #${task.id}`} aria-describedby={task.exportAvailability.canExport ? undefined : `task-export-reason-${task.id}`} disabled={!task.exportAvailability.canExport} title={task.exportAvailability.canExport ? '选择此任务进行批量导出' : task.exportAvailability.reason} /></td><td className="mono" data-label="ID">#{task.id}</td><td className="query-cell" data-label="选题">{task.query}</td><td className="mono" data-label="外部 ID">{task.config?.externalId || '—'}</td><td data-label="图片数">{task.config?.currentTextRevisionId ? `${task.config.imageCount}（自动）` : '自动 3–5'}</td><td data-label="生成状态"><StatusPill value={task.status} /></td><td data-label="耗时"><TaskTiming task={task} timingStats={timingStats} /></td><td data-label="审核状态"><StatusPill value={task.config?.reviewStatus} /></td><td className="row-action" data-label="操作"><div className="task-row-actions"><div className="inline"><Link className="button small" href={`/tasks/${task.id}`}>打开审核</Link>{task.exportAvailability.canExport ? <a className="button small" href={`/api/tasks/${task.id}/export`} download={`xhs-task-${task.id}.zip`}>导出 ZIP</a> : <button className="button small" type="button" disabled aria-describedby={`task-export-reason-${task.id}`} title={task.exportAvailability.reason}>导出 ZIP</button>}</div>{!task.exportAvailability.canExport && <span className="action-reason" id={`task-export-reason-${task.id}`} role="note">不可导出：{task.exportAvailability.reason}</span>}</div></td></tr>)}</tbody></table></div><nav className="pagination" aria-label="任务分页"><span>第 {result.pagination.page} / {Math.max(1, result.pagination.totalPages)} 页</span><div className="inline">{result.pagination.page > 1 && <Link className="button small" href={pageHref(result.pagination.page - 1)}>上一页</Link>}{result.pagination.page < result.pagination.totalPages && <Link className="button small" href={pageHref(result.pagination.page + 1)}>下一页</Link>}</div></nav></TaskBatchExportForm>}
  </>;
}
