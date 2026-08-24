import Link from 'next/link';

import { StatusPill } from '../components/status-pill';
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
  const { batches, initialBatch } = withAdminStore((store: any) => ({
    batches: store.listImportBatches({ page: 1, pageSize: 20 }).data,
    initialBatch: Number.isInteger(batchId) && batchId > 0 ? store.getImportBatch(batchId) : null,
  })) as any;
  return <>
    <header className="page-header"><div><span className="eyebrow">Excel intake</span><h1>把选题变成可靠的任务队列</h1><p className="subtle">先做结构预检，再按需求强度筛选，最后确认入队。</p></div></header>
    <ImportWorkbench key={initialBatch?.id ?? 'new'} initialBatch={initialBatch} />
    <section className="panel" style={{marginTop: 18}}><div className="panel-head"><h2>最近导入</h2></div>
      {batches.length === 0 ? <div className="empty-state">暂无导入记录</div> : <div className="table-wrap mobile-cards"><table><thead><tr><th>批次</th><th>文件</th><th>可入队 / 总数</th><th>待筛选</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{batches.map((batch: any) => <tr key={batch.id}><td data-label="批次">{batch.name}</td><td className="mono" data-label="文件">{batch.sourceFileName}</td><td data-label="可入队 / 总数">{batch.admittedRows} / {batch.totalRows}</td><td data-label="待筛选">{batch.pendingScreeningRows}</td><td data-label="状态"><StatusPill value={batch.status} /></td><td data-label="创建时间">{new Date(batch.createdAt).toLocaleString('zh-CN')}</td><td className="row-action" data-label="操作"><Link className="button small" href={`/imports?batchId=${batch.id}`}>{batch.status === 'COMMITTED' ? '查看' : '继续筛选'}</Link></td></tr>)}</tbody></table></div>}
    </section>
  </>;
}
