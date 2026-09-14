'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiRequest } from '../components/api-client';

type Queue = { id: string | null; version: string; query_package_name: string; review: number; qc: number; frozen: number; rework: number; image: number };
type Overview = { capabilities: { review: boolean; qc: boolean; admin: boolean }; queues: Queue[] };

export default function CopyFlowPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    try { setData(await apiRequest<Overview>('/api/control-plane/v1/copy-quality/queues')); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : '加载失败'); }
  }
  useEffect(() => { void refresh(); }, []);
  async function close(queue: Queue) {
    setBusy(true);
    try {
      await apiRequest(`/api/control-plane/v1/production-batches/${queue.id}/copy-sampling-freeze`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: Number(queue.version) }),
      });
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : '结批失败'); }
    finally { setBusy(false); }
  }
  return <section className="panel">
    <h1>文案工作入口</h1>
    <p>按最终审核人独立成批；未满抽样量的文案最迟等待 30 分钟，在下一次质检刷新或生图领取时结批抽检。</p>
    <nav className="row-action">
      <Link className="button" href="/workbench/personal">浏览任务</Link>
      {data?.capabilities.review && <Link className="button" href="/workbench/personal?state=COPY_REVIEW_PENDING">文案审核</Link>}
      {data?.capabilities.qc && <Link className="button" href="/copy-qa">文案质检</Link>}
      <button className="button" onClick={() => void refresh()}>刷新</button>
    </nav>
    {error && <p role="alert">{error}</p>}
    <div className="table-wrap"><table><thead><tr><th>队列</th><th>待审核</th><th>待质检</th><th>冻结</th><th>返工</th><th>可生图</th>{data?.capabilities.admin && <th>结批</th>}</tr></thead>
      <tbody>{data?.queues.map(q => <tr key={q.id ?? 'none'}><td>{q.query_package_name ?? '独立任务'}</td><td>{q.review}</td><td>{q.qc}</td><td>{q.frozen}</td><td>{q.rework}</td><td>{q.image}</td>{data.capabilities.admin && <td>{q.id && <button className="button" disabled={busy} onClick={() => void close(q)}>结批并抽检</button>}</td>}</tr>)}</tbody>
    </table></div>
  </section>;
}
