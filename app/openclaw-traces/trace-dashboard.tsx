import {
  Bot,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Database,
  FileJson,
  ShieldCheck,
  Waypoints,
} from 'lucide-react';

import styles from './openclaw-traces.module.css';

const PHASE_LABELS: Record<string, string> = {
  query_review: '选题审核',
  research: '联网研究',
  original_generation: '首稿生成',
  original_review: '首稿质检',
  reviewed_generation: '质检修订',
  reviewed_review: '修订复检',
};

function number(value: unknown) {
  return Number(value ?? 0).toLocaleString('zh-CN');
}

function duration(value: unknown) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return '—';
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1_000)}s`;
}

function dateTime(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN');
}

function preview(value: unknown, limit = 6_000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return '无内容';
  return text.length > limit ? `${text.slice(0, limit)}\n\n… 页面预览已截断，请下载完整脱敏 JSON 查看其余内容。` : text;
}

function CoverageItem({ label, available, note }: { label: string; available: boolean; note: string }) {
  return <li className={available ? styles.coverageReady : styles.coverageGap}>
    {available
      ? <CheckCircle2 aria-hidden="true" size={17} />
      : <CircleAlert aria-hidden="true" size={17} />}
    <div><strong>{label}</strong><span>{note}</span></div>
  </li>;
}

export function TraceDashboard({ report }: { report: any }) {
  const coverage = report.coverage;
  const sessionsById = new Map(report.openclaw.sessions.map((session: any) => [session.sessionId, session]));
  return <div className={styles.stack}>
    <section className={styles.metricGrid} aria-label="链路概览">
      <article><Clock3 aria-hidden="true" /><span>端到端耗时</span><strong>{duration(report.chain.durationMs)}</strong><small>{dateTime(report.chain.startedAt)} 开始</small></article>
      <article><Waypoints aria-hidden="true" /><span>OpenClaw 会话</span><strong>{number(report.openclaw.sessions.length)}</strong><small>{number(report.openclaw.auditEvents.length)} 条审计事件</small></article>
      <article><Bot aria-hidden="true" /><span>Token 合计</span><strong>{number(report.chain.usage.totalTokens)}</strong><small>输出 {number(report.chain.usage.output)} · 缓存读取 {number(report.chain.usage.cacheRead)}</small></article>
      <article><Database aria-hidden="true" /><span>证据源文件</span><strong>{number(report.sources.length)}</strong><small>附带 SHA-256 完整性摘要</small></article>
    </section>

    <section className={styles.twoColumn}>
      <article className={styles.panel}>
        <div className={styles.panelHead}><div><span>Coverage</span><h2>采集覆盖</h2></div><ShieldCheck aria-hidden="true" size={20} /></div>
        <ul className={styles.coverageList}>
          <CoverageItem label="业务请求、结果与阶段耗时" available={coverage.business.requestAndResult && coverage.business.phaseTimings} note="来自 queue.db 的持久化记录" />
          <CoverageItem label="OpenClaw 会话与 trajectory" available={coverage.openclaw.sessionMessages && coverage.openclaw.trajectories} note="包含 prompt、response、run 与 turn 对齐" />
          <CoverageItem label="Codex rollout" available={coverage.codex.rollouts} note="包含线程落盘记录与本地日志" />
          <CoverageItem label="研究原始 capability envelope" available={coverage.research.rawCapabilityEnvelope} note="当前未持久化；页面仅展示业务研究快照" />
          <CoverageItem label="原始 HTTP 报文" available={coverage.network.rawHttpCapture} note="当前 OpenClaw capture 未启用" />
        </ul>
      </article>
      <article className={styles.panel}>
        <div className={styles.panelHead}><div><span>Business context</span><h2>任务上下文</h2></div><FileJson aria-hidden="true" size={20} /></div>
        <dl className={styles.factGrid}>
          <div><dt>任务</dt><dd>#{report.business.job.id} · {report.business.job.status}</dd></div>
          <div><dt>生成记录</dt><dd>#{report.business.job.generation_id ?? '—'}</dd></div>
          <div className={styles.fullFact}><dt>Query</dt><dd>{report.business.job.query}</dd></div>
          <div><dt>首稿模型</dt><dd>{report.business.generation?.original_model ?? '—'}</dd></div>
          <div><dt>思考等级</dt><dd>{report.business.generation?.original_thinking ?? '—'}</dd></div>
        </dl>
      </article>
    </section>

    <section className={styles.panel}>
      <div className={styles.panelHead}><div><span>Execution timeline</span><h2>阶段时间线</h2></div><span className={styles.panelMeta}>{report.chain.phases.length} 个阶段</span></div>
      <ol className={styles.timeline} aria-label="链路阶段">
        {report.chain.phases.map((phase: any, index: number) => <li key={phase.phase}>
          <span className={styles.phaseIndex}>{index + 1}</span>
          <div className={styles.phaseBody}>
            <div className={styles.phaseTitle}><strong>{PHASE_LABELS[phase.phase] ?? phase.phase}</strong><span>{duration(phase.durationMs)}</span></div>
            <div className={styles.phaseMeta}>
              <span>{phase.model ?? phase.provider ?? '业务快照'}</span>
              <span>{phase.sessionId ? `Session ${phase.sessionId}` : '无独立 OpenClaw session'}</span>
              <span>{phase.usage ? `${number(phase.usage.totalTokens)} tokens` : 'Token 未持久化'}</span>
            </div>
          </div>
        </li>)}
      </ol>
    </section>

    <section className={styles.panel}>
      <div className={styles.panelHead}><div><span>OpenClaw sessions</span><h2>Prompt、Response 与 trajectory</h2></div><span className={styles.panelMeta}>服务端脱敏预览</span></div>
      <div className={styles.detailsStack}>
        {report.chain.phases.filter((phase: any) => phase.sessionId).map((phase: any) => {
          const session: any = sessionsById.get(phase.sessionId);
          return <details className={styles.detailCard} key={phase.sessionId}>
            <summary><span><strong>{PHASE_LABELS[phase.phase] ?? phase.phase}</strong><small>{phase.sessionId}</small></span><span>{number(session?.usage?.totalTokens)} tokens</span></summary>
            <dl className={styles.compactFacts}>
              <div><dt>Codex thread</dt><dd>{session?.threadId ?? '—'}</dd></div>
              <div><dt>Run / Turn</dt><dd>{session?.runId ?? '—'} / {session?.turnId ?? '—'}</dd></div>
              <div><dt>模型</dt><dd>{session?.provider ?? '—'} / {session?.model ?? '—'}</dd></div>
              <div><dt>观测耗时</dt><dd>{duration(session?.durationMs)}</dd></div>
            </dl>
            <div className={styles.payloadGrid}>
              <div><h3>User prompt</h3><pre>{preview(session?.userText)}</pre></div>
              <div><h3>Assistant response</h3><pre>{preview(session?.assistantText)}</pre></div>
            </div>
            <details className={styles.nestedDetail}><summary>查看 trajectory 预览（{session?.trajectory?.length ?? 0} 条）</summary><pre>{preview(session?.trajectory, 8_000)}</pre></details>
          </details>;
        })}
      </div>
    </section>

    <section className={styles.panel}>
      <div className={styles.panelHead}><div><span>Codex persistence</span><h2>Rollout 与运行日志</h2></div><span className={styles.panelMeta}>{report.codex.threads.length} 个线程</span></div>
      <div className={styles.detailsStack}>
        {report.codex.threads.map((item: any) => <details className={styles.detailCard} key={item.thread.id}>
          <summary><span><strong>{item.thread.id}</strong><small>{item.thread.model_provider ?? 'Codex thread'}</small></span><span>{item.records.length} rollout · {item.logs.length} logs</span></summary>
          <dl className={styles.compactFacts}>
            <div><dt>Reasoning</dt><dd>{item.thread.reasoning_effort ?? '—'}</dd></div>
            <div><dt>Tokens used</dt><dd>{number(item.thread.tokens_used)}</dd></div>
          </dl>
          <div className={styles.payloadGrid}>
            <div><h3>Rollout 末尾预览</h3><pre>{preview(item.records.slice(-12), 8_000)}</pre></div>
            <div><h3>日志末尾预览</h3><pre>{preview(item.logs.slice(-20), 8_000)}</pre></div>
          </div>
        </details>)}
      </div>
    </section>

    <section className={styles.panel}>
      <div className={styles.panelHead}><div><span>Audit & integrity</span><h2>审计事件与来源校验</h2></div><span className={styles.panelMeta}>{report.openclaw.auditEvents.length} 事件 · {report.sources.length} 文件</span></div>
      <div className={styles.auditList} role="list" aria-label="OpenClaw 审计事件">
        {report.openclaw.auditEvents.map((event: any) => <article role="listitem" key={event.event_id ?? event.sequence}>
          <div><strong>{event.action ?? event.kind ?? 'event'}</strong><span>{event.status ?? '—'}</span></div>
          <small>{dateTime(event.occurred_at)} · {event.session_id ?? '无 session'} · {event.run_id ?? '无 run'}</small>
        </article>)}
      </div>
      <details className={styles.sourceDisclosure}><summary>查看 {report.sources.length} 个来源文件及 SHA-256</summary><ul>{report.sources.map((source: any) => <li key={source.path}><span>{source.path}</span><code>{source.sha256}</code></li>)}</ul></details>
    </section>
  </div>;
}
