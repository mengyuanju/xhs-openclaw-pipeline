import { qualityDimensionRows } from '../tasks/[id]/review-presentation.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value, limit = 500) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const score = value => Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
const severityOrder = { redline: 0, blocking: 0, major: 1, warning: 2, minor: 3 };
const severityLabels = { redline: '红线问题', blocking: '阻断问题', major: '主要问题', minor: '轻微问题' };

/** Normalize legacy and model-provided reports without presenting missing evidence as a pass.
 * @returns {{ score: number | null, converted: boolean, summary: string, needsAttention: boolean,
 * issues: Array<{ label: string, evidence: string, severity: string, severityLabel: string }>,
 * dimensions: Array<{ label: string, score: number | null, evidence: string[] }>, limitations: string[] }}
 */
export function taskQualitySummary(result) {
  const source = record(result);
  const qc = record(source.qc);
  const rubric = record(qc.rubric);
  const converted = record(source.processing).type === 'LOCAL';
  const seenIssues = new Set();
  const issueValues = [...(Array.isArray(rubric.issueLabels) ? rubric.issueLabels.slice(0, 30) : []),
    ...(Array.isArray(qc.issues) ? qc.issues.slice(0, 30) : [])];
  const issues = (converted ? [] : issueValues).flatMap(value => {
    const issue = record(value);
    const label = text(issue.label, 100), evidence = text(issue.evidence);
    const severity = text(issue.severity, 30);
    const key = JSON.stringify([label, evidence]);
    if (!label || !evidence || seenIssues.has(key)) return [];
    seenIssues.add(key);
    return [{ label, evidence, severity,
      severityLabel: Object.hasOwn(severityLabels, severity) ? severityLabels[severity] : '待核对' }];
  }).sort((a, b) => (Object.hasOwn(severityOrder, a.severity) ? severityOrder[a.severity] : 2)
    - (Object.hasOwn(severityOrder, b.severity) ? severityOrder[b.severity] : 2));
  const dimensions = (converted ? [] : qualityDimensionRows({ qcDetail: qc })).map(item => ({
    label: item.label, score: score(item.score), evidence: item.evidence.slice(0, 20).map(value => text(value)).filter(Boolean),
  }));
  const obstacleSummary = dimensions.filter(item => item.score !== null && item.score < 2).slice(0, 3)
    .map(item => `${item.label}：${item.evidence[0] || `${item.score} 分，请人工核对。`}`).join('；');
  const currentScore = converted ? null : score(qc.overallScore);
  return {
    score: currentScore, converted, issues, dimensions,
    summary: converted ? '当前图片已转换格式或背景，未重新进行模型质检，请核对文字和透明边缘。'
      : text(qc.summary) || text(obstacleSummary) || '请结合逐项质检证据和当前图片完成审核。',
    needsAttention: currentScore === null || currentScore < 2 || issues.length > 0,
    limitations: (Array.isArray(qc.limitations) ? qc.limitations : []).slice(0, 10).map(value => text(value)).filter(Boolean),
  };
}
