import type { ReactNode } from 'react';

import { StatusPill } from '../components/status-pill';
import { formatDuration } from '../components/time-format';

export type ImportFlowStep = 1 | 2 | 3 | 4;

export function ImportFlowStage({
  step,
  title,
  summary,
  activeStep,
  available,
  completed,
  onSelect,
  children,
}: {
  step: ImportFlowStep;
  title: string;
  summary: string;
  activeStep: ImportFlowStep;
  available: boolean;
  completed: boolean;
  onSelect: (step: ImportFlowStep) => void;
  children: ReactNode;
}) {
  const isActive = activeStep === step;
  const stateLabel = isActive ? '当前步骤' : completed ? '已完成' : available ? '可查看' : '待完成';

  return <section
    className={`import-flow-step${isActive ? ' is-active' : ''}${completed ? ' is-complete' : ''}`}
    data-import-step={step}
  >
    <button
      className="import-flow-step-toggle"
      type="button"
      aria-expanded={isActive}
      aria-current={isActive ? 'step' : undefined}
      disabled={!available}
      onClick={() => onSelect(step)}
    >
      <span className="import-flow-step-index" aria-hidden="true">{completed ? '✓' : step}</span>
      <span className="import-flow-step-copy"><strong>{step}. {title}</strong><small>{summary}</small></span>
      <span className="import-flow-step-state">{stateLabel}</span>
    </button>
    {isActive && <div className="import-flow-step-body">{children}</div>}
  </section>;
}

export function ImportBatchDetails({ batch }: { batch: any }) {
  return <details className="import-batch-details">
    <summary>
      <span><strong>{batch.name}</strong><small>{batch.sourceFileName}</small></span>
      <span className="import-batch-details-counts">总计 {batch.totalRows} · 可入队 {batch.admittedRows} · 待筛选 {batch.pendingScreeningRows}</span>
      <StatusPill value={batch.status} />
    </summary>
    <div className="stats-grid import-batch-stats">
      <div className="stat-card"><span className="label">总行数</span><strong>{batch.totalRows}</strong></div>
      <div className="stat-card"><span className="label">可入队（强/中需）</span><strong>{batch.admittedRows}</strong></div>
      <div className="stat-card"><span className="label">已废弃（弱/无需）</span><strong>{batch.discardedRows}</strong></div>
      <div className="stat-card"><span className="label">待筛选</span><strong>{batch.pendingScreeningRows}</strong></div>
    </div>
    {batch.statistics?.taskCount > 0 && <dl className="batch-timing-summary">
      <div><dt>生成进度</dt><dd>{batch.statistics.finishedTaskCount} / {batch.statistics.taskCount}（{batch.statistics.progressPercent}%）</dd></div>
      <div><dt>开始时间</dt><dd>{batch.statistics.startedAt ? new Date(batch.statistics.startedAt).toLocaleString('zh-CN') : '尚未开始'}</dd></div>
      <div><dt>结束时间</dt><dd>{batch.statistics.finishedAt ? new Date(batch.statistics.finishedAt).toLocaleString('zh-CN') : '尚未结束'}</dd></div>
      <div><dt>批次耗时</dt><dd>{formatDuration(batch.statistics.wallDurationMs)}</dd></div>
      <div><dt>平均运行耗时</dt><dd>{formatDuration(batch.statistics.averageRunDurationMs)}</dd></div>
      <div><dt>质量修复</dt><dd>{batch.statistics.qualityRepairAttempts} 次</dd></div>
    </dl>}
  </details>;
}
