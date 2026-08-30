type ReviewIssue = {
  code?: string;
  severity?: 'WARNING' | 'BLOCKING';
  message?: string;
};

type StageReview = {
  stage?: 'QUERY' | 'TEXT';
  decision?: 'PASS' | 'REJECT';
  summary?: string;
  issues?: ReviewIssue[];
  source?: 'OPENCLAW' | 'MOCK' | 'COMPATIBILITY';
  model?: string | null;
  reviewedAt?: string;
};

type StageReviews = {
  query?: StageReview | null;
  text?: StageReview | null;
};

function sourceLabel(source: StageReview['source']) {
  if (source === 'OPENCLAW') return 'OPENCLAW 独立模型';
  if (source === 'MOCK') return 'MOCK 模拟验证';
  if (source === 'COMPATIBILITY') return '兼容模式（未调用独立审核模型）';
  return '来源未记录';
}

function StageReviewCard({ label, review }: { label: string; review?: StageReview | null }) {
  if (!review) {
    return <section className="stage-review-card empty">
      <div className="stage-review-head"><strong>{label}</strong><span>未记录</span></div>
      <p>该历史批次没有保存这一阶段的审核证据。</p>
    </section>;
  }
  const issues = Array.isArray(review.issues) ? review.issues : [];
  return <section className="stage-review-card">
    <div className="stage-review-head">
      <strong>{label}</strong>
      <span className={review.decision === 'PASS' ? 'stage-review-pass' : 'stage-review-reject'}>
        {review.decision === 'PASS' ? '通过' : '拒绝'}
      </span>
    </div>
    <p>{review.summary || '未记录审核摘要。'}</p>
    <div className="stage-review-meta">
      <span>{sourceLabel(review.source)}</span>
      {review.model && <span>模型：{review.model}</span>}
      {review.reviewedAt && <time dateTime={review.reviewedAt}>{new Date(review.reviewedAt).toLocaleString('zh-CN')}</time>}
    </div>
    {issues.length > 0 && <ul className="stage-review-issues">{issues.map((issue, index) => <li key={`${issue.code || 'ISSUE'}-${index}`}>
      <strong>{issue.severity === 'BLOCKING' ? 'BLOCKING' : 'WARNING'}</strong>
      <span>{issue.message || issue.code || '未记录问题说明'}</span>
    </li>)}</ul>}
  </section>;
}

export function StageReviewTrace({ stageReviews }: { stageReviews?: StageReviews | null }) {
  if (!stageReviews) {
    return <div className="stage-review-empty">历史批次未保存阶段审核结果。</div>;
  }
  return <div className="stage-review-grid" aria-label="本批次阶段审核">
    <StageReviewCard label="Query 审核" review={stageReviews.query} />
    <StageReviewCard label="文本生成后审核" review={stageReviews.text} />
  </div>;
}
