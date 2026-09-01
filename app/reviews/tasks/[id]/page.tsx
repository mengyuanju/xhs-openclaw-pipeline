import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ImagePreview } from '../../../components/image-preview';
import { StatusPill } from '../../../components/status-pill';
import { readServerSession, withAuthorizedReviewStore } from '../../../server-session';
import { StageDecisionForm } from './stage-decision-form';

export const dynamic = 'force-dynamic';

function eventLabel(action: string) {
  return action === 'TASK_ALLOCATED' ? '按条数分配任务'
    : action === 'TASK_REASSIGNED' ? '整体转派任务'
      : action === 'STAGE_DECISION_SUBMIT' ? '提交阶段结论'
        : action;
}

export default async function ReviewTaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Freviews');
  const rawId = (await params).id;
  if (!/^[1-9]\d*$/u.test(rawId)) notFound();
  const assignmentId = Number(rawId);
  const detail = withAuthorizedReviewStore(session, (store: any, actor: any) => ({
    actor,
    assignment: store.getReviewTaskAssignment(actor, assignmentId),
    events: store.listReviewTaskEvents(actor, assignmentId),
  })) as any;
  const { assignment } = detail;
  const current = assignment.task.currentTextRevision;
  const currentAssets = assignment.task.currentAssets;

  return <>
    <header className="page-header review-detail-header">
      <div>
        <Link className="subtle" href="/reviews">← 返回我的待办</Link>
        <h1>内容任务 #{assignment.taskId}</h1>
        <div className="inline">
          <StatusPill value={assignment.progress.status} />
          <span>负责人：{assignment.assignee.displayName}</span>
          <span className="subtle">{assignment.importBatch.name}</span>
        </div>
      </div>
    </header>

    <section className="panel review-task-context" aria-labelledby="review-task-query">
      <span className="section-kicker">任务范围</span>
      <h2 id="review-task-query">{assignment.task.query}</h2>
      <p className="subtle">这条任务的文案与图片始终由同一负责人核对；内容更新只会使旧结论失效，不会自动换人。</p>
    </section>

    <div className="review-task-stage-grid">
      <section className="panel review-task-stage" aria-labelledby="copy-stage-title">
        <div className="panel-head">
          <div><span className="section-kicker">01 · 文案审核</span><h2 id="copy-stage-title">当前文案</h2></div>
          <StatusPill value={assignment.progress.copy.status} />
        </div>
        {current ? <>
          <p className="subtle">文本版本 #{current.id}</p>
          <h3 className="review-task-copy-title">{current.title}</h3>
          <div className="review-copy-body">{current.body}</div>
          <div className="review-copy-tags">{current.tags.map((tag: string) => <span className="pill" key={tag}>{tag}</span>)}</div>
        </> : <div className="empty-state">当前任务还没有可审核的文案。</div>}
        <StageDecisionForm assignment={assignment} actor={detail.actor} stage="COPY" />
      </section>

      <section className="panel review-task-stage" aria-labelledby="image-stage-title">
        <div className="panel-head">
          <div><span className="section-kicker">02 · 图片审核</span><h2 id="image-stage-title">当前文案对应图片</h2></div>
          <StatusPill value={assignment.progress.image.status} />
        </div>
        {currentAssets.length === 0
          ? <div className="empty-state">当前文案还没有图片。图片生成后仍由 {assignment.assignee.displayName} 继续负责。</div>
          : <><p className="subtle">当前已就绪 {currentAssets.length} / {assignment.task.imageCount} 张；只有完整图片集全部通过图文匹配验收后才能提交图片结论。</p><div className="review-task-assets">{currentAssets.map((asset: any, index: number) => <article key={asset.id} className="review-task-asset">
            <ImagePreview
              src={`/api/review-task-assignments/${assignment.id}/assets/${asset.id}?v=${asset.sha256}`}
              alt={`第 ${asset.pageIndex || index + 1} 张图片`}
              width={asset.width}
              height={asset.height}
              position={index + 1}
              total={currentAssets.length}
            />
            <div><strong>第 {asset.pageIndex || index + 1} 张</strong><span>{asset.width} × {asset.height} · v{asset.revision}</span><StatusPill value={asset.alignmentStatus} /></div>
          </article>)}</div></>}
        <StageDecisionForm assignment={assignment} actor={detail.actor} stage="IMAGE" />
      </section>
    </div>

    <section className="panel review-event-panel" aria-labelledby="review-task-event-title">
      <div className="panel-head"><h2 id="review-task-event-title">责任与审核记录</h2><span>{detail.events.length} 条</span></div>
      <ol className="review-event-list">{detail.events.map((event: any) => <li key={event.id}><div><strong>{event.actor.displayName}</strong><span>{eventLabel(event.action)}</span></div><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString('zh-CN')}</time></li>)}</ol>
    </section>
  </>;
}
