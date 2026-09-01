'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { apiRequest } from '../components/api-client';
import { StatusPill } from '../components/status-pill';

function stageLabel(status: string) {
  return status === 'APPROVED' ? '已通过' : status === 'REJECTED' ? '已驳回' : status === 'STALE' ? '需重新审核' : '待审核';
}

function pageHref(name: 'taskPage' | 'queryPage', page: number) {
  return page > 1 ? `/reviews?${name}=${page}` : '/reviews';
}

export function ReviewWorkbench({ actor, taskAssignments, queryItems, users, batches }: any) {
  const router = useRouter();
  const isManager = actor.roles.some((role: string) => ['ADMIN', 'QC_LEAD'].includes(role));
  const canQuery = isManager || actor.roles.includes('QUERY_REVIEWER');
  const canCopy = isManager || actor.roles.includes('COPY_REVIEWER');
  const contentReviewers = users.filter((user: any) => user.roles.includes('COPY_REVIEWER'));
  const queryReviewers = users.filter((user: any) => user.roles.includes('QUERY_REVIEWER'));
  const [busyKey, setBusyKey] = useState('');
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);

  async function run(key: string, action: () => Promise<unknown>, success: string) {
    setBusyKey(key);
    setMessage('');
    setIsError(false);
    try {
      await action();
      setMessage(success);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败');
      setIsError(true);
    } finally {
      setBusyKey('');
    }
  }

  function allocate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const count = Number(form.get('count'));
    return run('allocate', () => apiRequest('/api/review-task-assignments/allocations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        importBatchId: Number(form.get('importBatchId')),
        assigneeUserId: Number(form.get('assigneeUserId')),
        count,
      }),
    }), `已分配 ${count} 条任务；这名质检员将负责每条任务的文案和图片。`);
  }

  function reassign(event: FormEvent<HTMLFormElement>, assignment: any) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    return run(`reassign-${assignment.id}`, () => apiRequest(`/api/review-task-assignments/${assignment.id}/reassignments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assigneeUserId: Number(form.get('assigneeUserId')),
        expectedVersion: assignment.version,
      }),
    }), '整条内容任务已转派，文案与图片责任同步变更。');
  }

  function seedQuery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    return run('seed-query', () => apiRequest('/api/review-work-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewType: 'QUERY', importBatchId: Number(form.get('importBatchId')) }),
    }), 'Query 质检单已生成；重复内容不会重复创建。');
  }

  function assignQuery(event: FormEvent<HTMLFormElement>, item: any) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    return run(`assign-query-${item.id}`, () => apiRequest(`/api/review-work-items/${item.id}/assignments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assigneeUserId: Number(form.get('assigneeUserId')), expectedVersion: item.version }),
    }), 'Query 预审已派单。');
  }

  function claimQuery(item: any) {
    return run(`claim-query-${item.id}`, () => apiRequest(`/api/review-work-items/${item.id}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: item.version }),
    }), '已领取 Query 质检作业。');
  }

  return <div className="stack review-center-stack">
    {isManager && <section className="panel review-seed-panel review-allocation-panel" aria-labelledby="allocation-title">
      <div>
        <span className="section-kicker">生产任务派单</span>
        <h2 id="allocation-title">按任务条数分配</h2>
        <p className="subtle">一个任务只计一条。分配后，同一名内容质检员（文案+图片）负责到最终图片审核完成。</p>
      </div>
      <form className="review-seed-form review-allocation-form" onSubmit={allocate}>
        <label htmlFor="allocation-batch">批次</label>
        <Select name="importBatchId" required disabled={batches.length === 0}>
          <SelectTrigger id="allocation-batch"><SelectValue placeholder="选择批次" /></SelectTrigger>
          <SelectContent>{batches.map((batch: any) => <SelectItem key={batch.id} value={String(batch.id)}>{batch.name}（剩余 {batch.unassignedCount}）</SelectItem>)}</SelectContent>
        </Select>
        <label htmlFor="allocation-user">负责人</label>
        <Select name="assigneeUserId" required disabled={contentReviewers.length === 0}>
          <SelectTrigger id="allocation-user"><SelectValue placeholder="选择内容质检员" /></SelectTrigger>
          <SelectContent>{contentReviewers.map((user: any) => <SelectItem key={user.id} value={String(user.id)}>{user.displayName}</SelectItem>)}</SelectContent>
        </Select>
        <label htmlFor="allocation-count">条数</label>
        <input className="input review-count-input" id="allocation-count" name="count" type="number" min="1" max="500" defaultValue="10" required />
        <button className="button primary" type="submit" disabled={busyKey === 'allocate' || batches.length === 0 || contentReviewers.length === 0}>{busyKey === 'allocate' ? '分配中…' : '确认分配'}</button>
      </form>
    </section>}

    <div className={`review-action-message ${isError ? 'notice error' : message ? 'notice success' : ''}`} role={isError ? 'alert' : 'status'} aria-live="polite">{message}</div>

    {canCopy && <section className="panel review-queue-panel" aria-labelledby="content-task-title">
      <div className="panel-head review-queue-head">
        <div><span className="section-kicker">主作业队列</span><h2 id="content-task-title">内容任务 · 文案到图片同一负责人</h2></div>
        <strong>{taskAssignments.pagination.totalItems} 条</strong>
      </div>
      {taskAssignments.data.length === 0
        ? <div className="empty-state">{isManager ? '还没有已分配的内容任务。请先按批次和条数分配。' : '当前没有分配给你的内容任务。'}</div>
        : <div className="table-wrap mobile-cards"><table className="review-work-table">
          <thead><tr><th>任务</th><th>审核内容</th><th>文案</th><th>图片</th><th>负责人</th><th>操作</th></tr></thead>
          <tbody>{taskAssignments.data.map((assignment: any) => <tr key={assignment.id}>
            <td className="mono" data-label="任务">#{assignment.taskId}</td>
            <td className="query-cell" data-label="审核内容"><strong>{assignment.task.query}</strong><small>{assignment.importBatch.name} · 当前 {assignment.task.currentAssets.length} 张图片</small></td>
            <td data-label="文案"><span className={`pill pill-${assignment.progress.copy.status.toLowerCase()}`}>{stageLabel(assignment.progress.copy.status)}</span></td>
            <td data-label="图片"><span className={`pill pill-${assignment.progress.image.status.toLowerCase()}`}>{stageLabel(assignment.progress.image.status)}</span></td>
            <td data-label="负责人">{assignment.assignee.displayName}</td>
            <td data-label="操作"><div className="review-row-actions">
              <Link className="button small primary" href={`/reviews/tasks/${assignment.id}`}>进入文图审核</Link>
              {isManager && <form className="review-assign-form" onSubmit={(event) => reassign(event, assignment)}>
                <Select name="assigneeUserId" defaultValue={String(assignment.assignee.id)} required>
                  <SelectTrigger aria-label={`转派任务 #${assignment.taskId}`}><SelectValue /></SelectTrigger>
                  <SelectContent>{contentReviewers.map((user: any) => <SelectItem key={user.id} value={String(user.id)}>{user.displayName}</SelectItem>)}</SelectContent>
                </Select>
                <button className="button small" type="submit" disabled={busyKey === `reassign-${assignment.id}`}>整体转派</button>
              </form>}
            </div></td>
          </tr>)}</tbody>
        </table></div>}
      {taskAssignments.pagination.totalPages > 1 && <nav className="review-pagination" aria-label="内容任务分页">
        {taskAssignments.pagination.page > 1 ? <Link className="button small" href={pageHref('taskPage', taskAssignments.pagination.page - 1)}>上一页</Link> : <span />}
        <span>第 {taskAssignments.pagination.page} / {taskAssignments.pagination.totalPages} 页</span>
        {taskAssignments.pagination.page < taskAssignments.pagination.totalPages ? <Link className="button small" href={pageHref('taskPage', taskAssignments.pagination.page + 1)}>下一页</Link> : <span />}
      </nav>}
    </section>}

    {canQuery && <section className="panel review-queue-panel" aria-labelledby="query-queue-title">
      <div className="panel-head review-queue-head">
        <div><span className="section-kicker">前置预审</span><h2 id="query-queue-title">Query 质检作业</h2><p className="subtle">Query 预审独立处理，不计入“文案到图片”的生产任务条数。</p></div>
        <strong>{queryItems.pagination.totalItems} 条</strong>
      </div>
      {isManager && <form className="review-seed-form review-query-seed-form" onSubmit={seedQuery}>
        <label htmlFor="query-seed-batch">导入批次</label>
        <Select name="importBatchId" required disabled={batches.length === 0}>
          <SelectTrigger id="query-seed-batch"><SelectValue placeholder="选择批次" /></SelectTrigger>
          <SelectContent>{batches.map((batch: any) => <SelectItem key={batch.id} value={String(batch.id)}>{batch.name}</SelectItem>)}</SelectContent>
        </Select>
        <button className="button" type="submit" disabled={busyKey === 'seed-query' || batches.length === 0}>{busyKey === 'seed-query' ? '生成中…' : '生成质检单'}</button>
      </form>}
      {queryItems.data.length === 0
        ? <div className="empty-state">还没有符合条件的质检作业。</div>
        : <div className="table-wrap mobile-cards"><table className="review-work-table">
          <thead><tr><th>ID</th><th>Query</th><th>状态</th><th>审核人</th><th>操作</th></tr></thead>
          <tbody>{queryItems.data.map((item: any) => <tr key={item.id}>
            <td className="mono" data-label="ID">#{item.id}</td>
            <td className="query-cell" data-label="Query"><strong>{item.subject.query}</strong><small>{item.subject.input?.category || '未分类'}</small></td>
            <td data-label="状态"><StatusPill value={item.status} /></td>
            <td data-label="审核人">{item.assignee?.displayName || '未分配'}</td>
            <td data-label="操作"><div className="review-row-actions">
              <Link className="button small" href={`/reviews/${item.id}`}>打开</Link>
              {!isManager && item.status === 'OPEN' && item.assignee === null && <button className="button small primary" type="button" disabled={busyKey === `claim-query-${item.id}`} onClick={() => claimQuery(item)}>领取</button>}
              {isManager && ['OPEN', 'IN_REVIEW'].includes(item.status) && <form className="review-assign-form" onSubmit={(event) => assignQuery(event, item)}>
                <Select name="assigneeUserId" defaultValue={item.assignee ? String(item.assignee.id) : undefined} required>
                  <SelectTrigger aria-label={`为 Query 质检单 #${item.id} 选择审核人`}><SelectValue placeholder="选择人员" /></SelectTrigger>
                  <SelectContent>{queryReviewers.map((user: any) => <SelectItem key={user.id} value={String(user.id)}>{user.displayName}</SelectItem>)}</SelectContent>
                </Select>
                <button className="button small" type="submit" disabled={busyKey === `assign-query-${item.id}`}>派单</button>
              </form>}
            </div></td>
          </tr>)}</tbody>
        </table></div>}
      {queryItems.pagination.totalPages > 1 && <nav className="review-pagination" aria-label="Query 作业分页">
        {queryItems.pagination.page > 1 ? <Link className="button small" href={pageHref('queryPage', queryItems.pagination.page - 1)}>上一页</Link> : <span />}
        <span>第 {queryItems.pagination.page} / {queryItems.pagination.totalPages} 页</span>
        {queryItems.pagination.page < queryItems.pagination.totalPages ? <Link className="button small" href={pageHref('queryPage', queryItems.pagination.page + 1)}>下一页</Link> : <span />}
      </nav>}
    </section>}
  </div>;
}
