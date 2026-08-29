import Link from 'next/link';

import { StatusPill } from '../components/status-pill';
import { formatDuration } from '../components/time-format';
import { withAdminStore } from '../../src/admin/runtime.mjs';
import { ImportWorkbench } from './import-workbench';

export const dynamic = 'force-dynamic';

export default async function ImportsPage({
  searchParams,
}: {
  searchParams: Promise<{ batchId?: string | string[] }>;
}) {
  const rawBatchId = (await searchParams).batchId;
  const batchId = Array.isArray(rawBatchId) ? Number.NaN : Number(rawBatchId);
  const { batches, initialBatch, timingStats } = withAdminStore((store: any) => ({
    batches: store.listImportBatches({ page: 1, pageSize: 20 }).data,
    initialBatch: Number.isInteger(batchId) && batchId > 0 ? store.getImportBatch(batchId) : null,
    timingStats: store.getTaskTimingStats(),
  })) as any;
  return <>
    <header className="page-header"><div><span className="eyebrow">Excel intake</span><h1 className="sr-only">选题导入</h1><p className="subtle">先做结构预检，再由 OpenClaw 检测需求强度，人工复核后确认入队。</p></div></header>
    <ImportWorkbench key={initialBatch?.id ?? 'new'} initialBatch={initialBatch} timingStats={timingStats} />
    <details className="panel recent-imports-disclosure" open={!initialBatch}>
      <summary><span><strong>最近导入</strong><small>{initialBatch ? '当前批次处理完成后再展开查看' : `共 ${batches.length} 个最近批次`}</small></span><span className="subtle">展开记录</span></summary>
      {batches.length === 0 ? <div className="empty-state">暂无导入记录</div> : <div className="table-wrap mobile-cards"><table><thead><tr><th>批次</th><th>文件</th><th>可入队 / 总数</th><th>生成进度</th><th>批次耗时</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{batches.map((batch: any) => <tr key={batch.id}><td data-label="批次">{batch.name}</td><td className="mono" data-label="文件">{batch.sourceFileName}</td><td data-label="可入队 / 总数">{batch.admittedRows} / {batch.totalRows}</td><td data-label="生成进度">{batch.statistics.taskCount > 0 ? `${batch.statistics.finishedTaskCount} / ${batch.statistics.taskCount}（${batch.statistics.progressPercent}%）` : '尚未入队'}</td><td data-label="批次耗时">{formatDuration(batch.statistics.wallDurationMs)}</td><td data-label="状态"><StatusPill value={batch.status} /></td><td data-label="创建时间">{new Date(batch.createdAt).toLocaleString('zh-CN')}</td><td className="row-action" data-label="操作"><Link className="button small" href={`/imports?batchId=${batch.id}`}>{batch.status === 'COMMITTED' ? '查看' : '继续筛选'}</Link></td></tr>)}</tbody></table></div>}
    </details>
  </>;
}
