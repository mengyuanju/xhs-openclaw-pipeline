import { StatusPill } from '../components/status-pill';
import { withAdminStore } from '../../src/admin/runtime.mjs';
import { ImportWorkbench } from './import-workbench';

export const dynamic = 'force-dynamic';

export default function ImportsPage() {
  const batches = (withAdminStore((store: any) => store.listImportBatches({ page: 1, pageSize: 20 })) as any).data;
  return <>
    <header className="page-header"><div><span className="eyebrow">Excel intake</span><h1>把选题变成可靠的任务队列</h1><p className="subtle">先预览、再提交。错误行不会偷偷进入生产。</p></div></header>
    <ImportWorkbench />
    <section className="panel" style={{marginTop: 18}}><div className="panel-head"><h2>最近导入</h2></div>
      {batches.length === 0 ? <div className="empty-state">暂无导入记录</div> : <div className="table-wrap"><table><thead><tr><th>批次</th><th>文件</th><th>有效 / 总数</th><th>状态</th><th>创建时间</th></tr></thead><tbody>{batches.map((batch: any) => <tr key={batch.id}><td>{batch.name}</td><td className="mono">{batch.sourceFileName}</td><td>{batch.validRows} / {batch.totalRows}</td><td><StatusPill value={batch.status} /></td><td>{new Date(batch.createdAt).toLocaleString('zh-CN')}</td></tr>)}</tbody></table></div>}
    </section>
  </>;
}
