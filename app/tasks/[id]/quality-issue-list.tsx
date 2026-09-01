type QualityIssue = {
  severity: 'minor' | 'major' | 'redline';
  severityLabel: string;
  scoreCap: number;
  capReason: string;
  label: string;
  evidence: string;
};

export function QualityIssueList({ issues }: { issues: QualityIssue[] }) {
  if (issues.length === 0) return null;

  return <section className="quality-issues" aria-label="问题标签与详细原因">
    <div className="quality-issues-head">
      <strong className="batch-label">问题标签</strong>
      <span>问题标签会按严重度限制最终分，不能被维度分抵消。</span>
    </div>
    <ul className="quality-issue-list">
      {issues.map((issue, index) => <li className="quality-issue-item" data-severity={issue.severity} key={`${issue.severity}-${issue.label}-${index}`}>
        <div className="quality-issue-heading">
          <strong className="quality-issue-severity">{issue.severityLabel}</strong>
          <span className="quality-issue-code">{issue.severity}</span>
          <span className="quality-issue-cap">最终分最高 {issue.scoreCap} 分</span>
        </div>
        <strong className="quality-issue-name">{issue.label}</strong>
        <p className="quality-issue-reason"><span>详细原因</span>{issue.evidence}</p>
        <p className="quality-issue-cap-reason">阻断说明：{issue.capReason}</p>
      </li>)}
    </ul>
  </section>;
}
