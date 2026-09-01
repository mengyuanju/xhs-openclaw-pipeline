'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { apiRequest } from '../../components/api-client';

const QUERY_REASONS = [
  ['UNCLEAR_GOAL', '内容目标不清晰'],
  ['DEMAND_WEAK', '需求强度不足'],
  ['RISK_BOUNDARY', '风险边界不清'],
  ['DUPLICATE', '重复或低价值选题'],
];
const COPY_REASONS = [
  ['QUERY_MISMATCH', '没有覆盖 Query 主需'],
  ['TITLE_UNFULFILLED', '标题承诺未兑现'],
  ['FACT_RISK', '事实或来源风险'],
  ['STYLE_ISSUE', '文案表达不符合要求'],
  ['TAG_MISMATCH', '标签与正文不一致'],
];

export function ReviewDecisionForm({ item, actor }: { item: any; actor: any }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const isReviewer = actor.subject === 'user';
  const canClaim = isReviewer && item.status === 'OPEN' && item.assignee === null;
  const canDecide = isReviewer && item.status === 'IN_REVIEW' && item.assignee?.id === actor.userId;
  const reasons = item.reviewType === 'QUERY' ? QUERY_REASONS : COPY_REASONS;

  async function run(action: () => Promise<unknown>, success: string, returnToQueue = false) {
    setBusy(true);
    setMessage('');
    setIsError(false);
    try {
      await action();
      setMessage(success);
      if (returnToQueue) router.push('/reviews');
      else router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败');
      setIsError(true);
    } finally {
      setBusy(false);
    }
  }

  function claim() {
    return run(() => apiRequest(`/api/review-work-items/${item.id}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: item.version }),
    }), '已经领取，可以提交审核结论。');
  }

  function decide(event: FormEvent<HTMLFormElement>) {
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
    return run(() => apiRequest(`/api/review-work-items/${item.id}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, reasonCodes, note, expectedVersion: item.version }),
    }), '审核结论已提交，正在返回我的待办。', true);
  }

  return <aside className="panel review-submit-panel" aria-labelledby="review-submit-title">
    <div><span className="section-kicker">人工结论</span><h2 id="review-submit-title">提交审核结论</h2></div>
    <div className={`review-action-message ${isError ? 'notice error' : message ? 'notice success' : ''}`} role={isError ? 'alert' : 'status'} aria-live="polite">{message}</div>
    {canClaim && <div className="review-claim-card"><p>该作业尚未分配。领取后会锁定给当前账号，其他人员不能同时提交。</p><button className="button primary" type="button" disabled={busy} onClick={claim}>领取</button></div>}
    {canDecide && <form className="stack" onSubmit={decide}>
      <fieldset className="review-decision-options"><legend>审核结果</legend><label><input type="radio" name="decision" value="APPROVED" defaultChecked />通过</label><label><input type="radio" name="decision" value="REJECTED" />驳回</label></fieldset>
      <fieldset className="review-reason-options"><legend>问题原因（驳回时选择）</legend>{reasons.map(([code, label]) => <label key={code}><input type="checkbox" name="reasonCodes" value={code} />{label}</label>)}</fieldset>
      <div className="field"><label htmlFor="review-note">审核说明</label><textarea className="textarea" id="review-note" name="note" maxLength={2_000} placeholder="记录具体证据或修改建议" /></div>
      <button className="button primary" type="submit" disabled={busy}>{busy ? '提交中…' : '提交审核结论'}</button>
    </form>}
    {!canClaim && !canDecide && <div className="empty-state">{item.decision ? `该作业已${item.decision.decision === 'APPROVED' ? '通过' : '驳回'}，结论不可覆盖。` : actor.subject === 'admin' ? '管理员负责派单，审核结论需由质检人员账号提交。' : '该作业当前不能由本账号处理。'}</div>}
  </aside>;
}
