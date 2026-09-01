'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { apiRequest } from '../../../components/api-client';

const COPY_REASONS = [
  ['QUERY_MISMATCH', '没有覆盖 Query 主需'],
  ['TITLE_UNFULFILLED', '标题承诺未兑现'],
  ['FACT_RISK', '事实或来源风险'],
  ['STYLE_ISSUE', '文案表达不符合要求'],
  ['TAG_MISMATCH', '标签与正文不一致'],
];
const IMAGE_REASONS = [
  ['COPY_IMAGE_MISMATCH', '图片与当前文案不一致'],
  ['VISUAL_QUALITY', '清晰度、构图或视觉质量不足'],
  ['PAGE_MISSING', '页面缺失或顺序不完整'],
  ['TEXT_RENDERING', '图中文字错误或不可读'],
  ['POLICY_RISK', '图片存在安全或合规风险'],
];

function statusText(status: string) {
  return status === 'APPROVED' ? '当前版本已通过。'
    : status === 'REJECTED' ? '当前版本已驳回，可在修正或复核后提交新结论。'
      : status === 'STALE' ? '当前内容或完整性状态已变化，需要重新审核。'
        : '尚未提交人工结论。';
}

export function StageDecisionForm({
  assignment,
  actor,
  stage,
}: {
  assignment: any;
  actor: any;
  stage: 'COPY' | 'IMAGE';
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const progress = stage === 'COPY' ? assignment.progress.copy : assignment.progress.image;
  const isOwner = actor.subject === 'user' && assignment.assignee.id === actor.userId;
  const stageIsReviewable = stage === 'COPY'
    ? Boolean(assignment.task.currentTextRevision)
    : assignment.progress.copy.status === 'APPROVED' && assignment.task.currentAssets.length > 0;
  const canApprove = stage === 'COPY'
    ? Boolean(assignment.task.currentTextRevision)
    : assignment.task.imageSetReady;
  const canDecide = isOwner && stageIsReviewable && progress.status !== 'APPROVED';
  const reasons = stage === 'COPY' ? COPY_REASONS : IMAGE_REASONS;

  async function decide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const decision = form.get('decision');
    const reasonCodes = form.getAll('reasonCodes');
    const note = String(form.get('note') || '');
    if (decision === 'REJECTED' && reasonCodes.length === 0 && !note.trim()) {
      setMessage('驳回时至少选择一个原因或填写说明。');
      setIsError(true);
      return;
    }
    setBusy(true);
    setMessage('');
    setIsError(false);
    try {
      await apiRequest(`/api/review-task-assignments/${assignment.id}/stage-decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage, decision, reasonCodes, note, expectedVersion: assignment.version }),
      });
      setMessage(stage === 'COPY' ? '文案结论已记录。' : '图片结论已记录。');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '提交失败');
      setIsError(true);
    } finally {
      setBusy(false);
    }
  }

  return <div className="review-task-decision">
    <div className="review-stage-summary" role="status">
      <strong>{stage === 'COPY' ? '文案结论' : '图片结论'}</strong>
      <span>{statusText(progress.status)}</span>
      {progress.decision?.note && <p>最近说明：{progress.decision.note}</p>}
    </div>
    <div className={`review-action-message ${isError ? 'notice error' : message ? 'notice success' : ''}`} role={isError ? 'alert' : 'status'} aria-live="polite">{message}</div>
    {canDecide && <form className="stack" onSubmit={decide}>
      <fieldset className="review-decision-options"><legend>审核结果</legend><label><input type="radio" name="decision" value="APPROVED" defaultChecked={canApprove} disabled={!canApprove} />通过</label><label><input type="radio" name="decision" value="REJECTED" defaultChecked={!canApprove} />驳回</label></fieldset>
      <fieldset className="review-reason-options"><legend>问题原因（驳回时选择）</legend>{reasons.map(([code, label]) => <label key={code}><input type="checkbox" name="reasonCodes" value={code} />{label}</label>)}</fieldset>
      <div className="field"><label htmlFor={`${stage.toLowerCase()}-review-note`}>审核说明</label><textarea className="textarea" id={`${stage.toLowerCase()}-review-note`} name="note" maxLength={2_000} placeholder="记录具体证据或修改建议" /></div>
      <button className="button primary" type="submit" disabled={busy}>{busy ? '提交中…' : `提交${stage === 'COPY' ? '文案' : '图片'}结论`}</button>
    </form>}
    {!canDecide && <p className="subtle review-stage-blocked">{!isOwner
      ? '只有当前负责人可以提交该阶段结论。'
      : progress.status === 'APPROVED'
        ? '当前版本已经通过；内容变化后会自动要求重新审核。'
        : stage === 'IMAGE'
          ? assignment.progress.copy.status !== 'APPROVED'
            ? '当前文案通过后才可审核图片。'
            : '当前文案对应的图片生成后才可提交图片结论。'
          : '文案生成后才可提交结论。'}</p>}
    {canDecide && !canApprove && <p className="subtle review-stage-blocked">图片尚未完整就绪，可以先驳回并说明问题；只有 {assignment.task.imageCount} 张当前图片全部通过图文匹配验收后才能选择“通过”。</p>}
  </div>;
}
