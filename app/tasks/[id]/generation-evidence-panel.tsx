import { PromptTrace } from './generation-prompt-trace';
import { StageReviewTrace } from './generation-stage-reviews';
import { researchSourceRows } from './generation-evidence-presentation.mjs';

function formattedTime(value?: string | null) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '时间未记录' : date.toLocaleString('zh-CN');
}

function researchEmptyMessage(snapshot: any) {
  if (!snapshot) return '该历史批次未保存联网资料；新的 Live 文案生成会记录可点击来源。';
  if (snapshot.status === 'FAILED') return '联网研究未完成，因此没有可用的资料来源链接。';
  return '本批次没有可展示的公开资料来源。';
}

export function GenerationEvidencePanel({ run }: { run?: any }) {
  const snapshot = run?.researchSnapshot;
  const sources = researchSourceRows(snapshot);
  return <section className="panel generation-evidence-panel" aria-labelledby="generation-evidence-title">
    <div className="panel-head generation-evidence-head">
      <div>
        <span className="section-kicker">02 · 生成依据</span>
        <h2 id="generation-evidence-title">生成依据与自动审核</h2>
        <p className="subtle">集中查看最新批次使用的资料、模型请求摘要和生成前审核结果。</p>
      </div>
      <span className="evidence-run-label">{run ? `最新批次 #${run.attempt || '—'}` : '尚无生成批次'}</span>
    </div>

    {!run
      ? <div className="empty-state">任务还没有生成记录，完成一次生成后会在这里显示来源和自动审核证据。</div>
      : <>
          <div className="generation-evidence-grid">
            <section className="evidence-section" aria-labelledby="research-evidence-title">
              <div className="evidence-section-head">
                <div><span className="evidence-eyebrow">Research</span><h3 id="research-evidence-title">文案资料来源</h3></div>
                <span>{sources.length} 条</span>
              </div>
              {snapshot && <p className="evidence-meta">研究快照（不代表每条都被最终文案引用） · 检索词：{snapshot.query || '未记录'} · 提供方：{snapshot.provider || '未记录'} · {formattedTime(snapshot.searchedAt)}</p>}
              {sources.length === 0
                ? <div className="evidence-empty">{researchEmptyMessage(snapshot)}</div>
                : <ol className="research-source-list">{sources.map((source: any, index: number) => <li key={source.url}>
                    <div className="research-source-heading">
                      <span className="source-index">{String(index + 1).padStart(2, '0')}</span>
                      <a className="research-source-link" href={source.url} target="_blank" rel="noopener noreferrer">
                        {source.title}<span aria-hidden="true">↗</span>
                      </a>
                    </div>
                    <p>{source.snippet}</p>
                    <div className="research-source-meta"><span>{source.siteName}</span><span>{source.provider}</span>{source.retrievedAt && <time dateTime={source.retrievedAt}>{formattedTime(source.retrievedAt)}</time>}</div>
                  </li>)}</ol>}
            </section>

            <section className="evidence-section" aria-labelledby="stage-review-title">
              <div className="evidence-section-head">
                <div><span className="evidence-eyebrow">Gate review</span><h3 id="stage-review-title">Query 与文案审核</h3></div>
              </div>
              <StageReviewTrace stageReviews={run?.stageReviews} />
            </section>
          </div>

          <details className="evidence-prompt-details">
            <summary>查看本批次用户提示词（中文审核摘要）</summary>
            <PromptTrace run={run} />
          </details>
        </>}
  </section>;
}
