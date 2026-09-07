import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { taskQualitySummary } from './task-quality-presentation.mjs';

export function TaskQualitySummary({ result, onShowImages }: { result: unknown; onShowImages?: () => void }) {
  const report = taskQualitySummary(result);
  return <section className="workbench-quality-summary" aria-label="当前图片自动质检" data-attention={report.needsAttention}>
    <div className="workbench-quality-heading">
      <div><h3>自动质检 · {report.score === null ? '待人工核对' : `${report.score} / 3 分`}</h3>
        <p>仅针对当前图片版本，最终结果由人工审核确认。</p></div>
      {onShowImages && <Button unstyled className="button small" type="button" onClick={onShowImages}>查看图片</Button>}
    </div>
    <p>{report.summary}</p>
    {report.issues.length > 0 && <ul className="workbench-quality-issues">{report.issues.slice(0, 3).map((issue, index) =>
      <li key={index}><strong>{issue.severityLabel} · {issue.label}</strong><p>{issue.evidence}</p></li>)}</ul>}
    {(report.issues.length > 3 || report.dimensions.length > 0 || report.limitations.length > 0) && <Disclosure>
      <DisclosureTrigger>查看完整质检证据{report.issues.length > 0 ? ` · ${report.issues.length} 个问题` : ''}</DisclosureTrigger>
      <DisclosureContent>
        {report.issues.length > 3 && <ul className="workbench-quality-issues">{report.issues.slice(3).map((issue, index) =>
          <li key={index}><strong>{issue.severityLabel} · {issue.label}</strong><p>{issue.evidence}</p></li>)}</ul>}
        {report.dimensions.map((dimension, index) => <div className="workbench-quality-dimension" key={index}>
          <strong>{dimension.label} · {dimension.score === null ? '未评分' : `${dimension.score} 分`}</strong>
          {dimension.evidence.map((value, i) => <p key={i}>{value}</p>)}
        </div>)}
        {report.limitations.map((value, i) => <p className="muted" key={i}>{value}</p>)}
      </DisclosureContent>
    </Disclosure>}
  </section>;
}
