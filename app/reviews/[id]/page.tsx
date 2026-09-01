import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { StatusPill } from '../../components/status-pill';
import { readServerSession, withAuthorizedReviewStore } from '../../server-session';
import { ReviewDecisionForm } from './review-decision-form';

export const dynamic = 'force-dynamic';

function Snapshot({ item }: { item: any }) {
  if (item.reviewType === 'QUERY') {
    return <section className="panel review-subject-panel" aria-labelledby="query-subject-title">
      <span className="section-kicker">Query 快照</span>
      <h2 id="query-subject-title">{item.subject.query}</h2>
      <dl className="review-subject-facts">
        <div><dt>分类</dt><dd>{item.subject.input?.category || '未提供'}</dd></div>
        <div><dt>目标用户</dt><dd>{item.subject.input?.targetAudience || '未提供'}</dd></div>
        <div><dt>需求强度</dt><dd>{item.subject.demandLevel || '未判定'}</dd></div>
        <div><dt>预筛选原因</dt><dd>{item.subject.screeningReason || '未记录'}</dd></div>
      </dl>
      <p className="review-hash mono">内容指纹：{item.subjectSha256}</p>
    </section>;
  }
  return <section className="panel review-subject-panel" aria-labelledby="copy-subject-title">
    <span className="section-kicker">文案快照</span>
    <p className="subtle">原 Query：{item.subject.query}</p>
    <h2 id="copy-subject-title">{item.subject.title}</h2>
    <div className="review-copy-body">{item.subject.body}</div>
    <div className="review-copy-tags">{item.subject.tags?.map((tag: string) => <span className="pill" key={tag}>{tag}</span>)}</div>
    <p className="review-hash mono">内容指纹：{item.subjectSha256}</p>
  </section>;
}

export default async function ReviewDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await readServerSession();
  if (!session) redirect('/login?next=%2Freviews');
  const rawId = (await params).id;
  if (!/^[1-9]\d*$/u.test(rawId)) notFound();
  const id = Number(rawId);
  const detail = withAuthorizedReviewStore(session, (store: any, actor: any) => {
    return {
      actor,
      item: store.getReviewWorkItem(actor, id),
      events: store.listReviewEvents(actor, id),
    };
  }) as any;

  return <>
    <header className="page-header review-detail-header">
      <div><Link className="subtle" href="/reviews">← 返回我的待办</Link><h1>{detail.item.reviewType === 'QUERY' ? 'Query 质检' : '文案质检'} #{detail.item.id}</h1><div className="inline"><StatusPill value={detail.item.status} /><span>{detail.item.assignee?.displayName || '尚未分配'}</span></div></div>
    </header>
    <div className="review-detail-grid">
      <Snapshot item={detail.item} />
      <ReviewDecisionForm item={detail.item} actor={detail.actor} />
    </div>
    <section className="panel review-event-panel" aria-labelledby="review-event-title">
      <div className="panel-head"><h2 id="review-event-title">操作记录</h2><span>{detail.events.length} 条</span></div>
      <ol className="review-event-list">{detail.events.map((event: any) => <li key={event.id}><div><strong>{event.actor.displayName}</strong><span>{event.action}</span></div><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString('zh-CN')}</time></li>)}</ol>
    </section>
  </>;
}
