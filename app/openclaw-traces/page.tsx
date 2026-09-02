import { CircleAlert, Download, Waypoints } from 'lucide-react';

import { adminDatabasePath, adminOpenClawRoot } from '../../src/admin/runtime.mjs';
import {
  collectOpenClawCodexTrace,
  listOpenClawCodexTraceJobs,
} from '../../src/openclaw-trace-export.mjs';
import styles from './openclaw-traces.module.css';
import { TraceDashboard } from './trace-dashboard';

export const dynamic = 'force-dynamic';

function requestedJobId(value: string | string[] | undefined) {
  if (Array.isArray(value) || !value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export default async function OpenClawTracesPage({
  searchParams,
}: {
  searchParams: Promise<{ jobId?: string | string[] }>;
}) {
  let jobs: any[] = [];
  let report: any = null;
  try {
    const databasePath = adminDatabasePath();
    jobs = listOpenClawCodexTraceJobs({ databasePath, limit: 30 });
    const requested = requestedJobId((await searchParams).jobId);
    const selected = jobs.find((job: any) => job.id === requested) ?? jobs[0] ?? null;
    if (selected) {
      report = collectOpenClawCodexTrace({
        databasePath,
        openClawRoot: adminOpenClawRoot(),
        jobId: selected.id,
      });
    }
  } catch {
    return <>
      <PageHeader />
      <div className={styles.error} role="alert">
        <CircleAlert aria-hidden="true" size={18} />
        <div><strong>暂时无法读取链路数据</strong><span>请确认业务数据库与 OpenClaw 本地目录可用后重试。</span></div>
      </div>
    </>;
  }

  return <>
    <PageHeader />
    {report ? <>
      <section className={styles.toolbar} aria-label="链路任务选择">
        <form action="/openclaw-traces" className={styles.selector}>
          <label htmlFor="trace-job">已完成的文案任务</label>
          <select id="trace-job" name="jobId" defaultValue={String(report.business.job.id)}>
            {jobs.map((job: any) => <option key={job.id} value={job.id}>
              #{job.id} · {job.query}
            </option>)}
          </select>
          <button className="button" type="submit">查看任务</button>
        </form>
        <a className="button primary" href={`/api/openclaw-traces/${report.business.job.id}`}>
          <Download aria-hidden="true" size={15} />下载完整脱敏 JSON
        </a>
      </section>
      <TraceDashboard report={report} />
    </> : <div className={styles.empty} role="status">
      <Waypoints aria-hidden="true" size={24} />
      <div><strong>还没有可展示的完整链路</strong><span>完成一次“单独生成文案”后，这里会自动出现对应任务。</span></div>
    </div>}
  </>;
}

function PageHeader() {
  return <header className="page-header">
    <div>
      <span className="eyebrow">OpenClaw observability</span>
      <h1>OpenClaw → Codex 模型链路</h1>
      <p className="subtle">按业务任务对齐 OpenClaw 会话、审计记录、Codex rollout 与 Token 用量；页面与下载内容均经过服务端脱敏。</p>
    </div>
  </header>;
}
