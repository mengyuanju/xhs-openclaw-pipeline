import { BookOpen, ExternalLink } from 'lucide-react';

type CopyGenerationResearchSource = {
  title: string;
  url: string;
  snippet: string;
  siteName: string;
  provider: string;
  retrievedAt: string;
};

type CopyGenerationResearchAttempt = {
  provider: string;
  status: 'COMPLETED' | 'FAILED';
  error: string | null;
};

export type CopyGenerationResearch = {
  schemaVersion: number;
  status: 'COMPLETED' | 'FAILED';
  query: string;
  searchedAt: string;
  provider: string | null;
  summary: string | null;
  attempts: CopyGenerationResearchAttempt[];
  sources: CopyGenerationResearchSource[];
};

function formatResearchDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未记录' : date.toLocaleString('zh-CN');
}

export function CopyGenerationResearchPanel({
  research,
}: {
  research: CopyGenerationResearch | null;
}) {
  return <section className="copy-research" aria-labelledby="copy-research-heading">
    <div className="copy-research-head">
      <div>
        <BookOpen aria-hidden="true" size={17} />
        <div>
          <span className="section-kicker">Research evidence</span>
          <h3 id="copy-research-heading">联网研究资料</h3>
        </div>
      </div>
      <span className="pill">{research ? `${research.sources.length} 个来源` : '未保存'}</span>
    </div>
    {!research ? <p className="copy-research-empty">这条历史记录没有保存联网研究资料。</p> : <>
      <dl className="copy-research-meta">
        <div>
          <dt>检索主题</dt>
          <dd>{research.query}</dd>
        </div>
        <div>
          <dt>检索服务</dt>
          <dd>{research.provider ?? '未记录'}</dd>
        </div>
        <div>
          <dt>检索时间</dt>
          <dd><time dateTime={research.searchedAt}>{formatResearchDate(research.searchedAt)}</time></dd>
        </div>
      </dl>
      <div className="copy-research-summary">
        <strong>资料摘要</strong>
        <p>{research.summary ?? '本次联网研究没有返回可保存的汇总摘要，请直接核验下方来源。'}</p>
      </div>
      {research.sources.length > 0 ? <ol className="copy-research-source-list" aria-label="联网研究来源">
        {research.sources.map((source) => <li key={source.url}>
          <article>
            <div className="copy-research-source-head">
              <div>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${source.title}（在新窗口打开）`}
                >
                  {source.title}<ExternalLink aria-hidden="true" size={13} />
                </a>
                <small>{source.siteName}</small>
              </div>
              <span className="pill">{source.provider}</span>
            </div>
            <p>{source.snippet || '该来源没有返回可保存的摘要片段，请打开原页面核验。'}</p>
            <small>资料保存于 <time dateTime={source.retrievedAt}>{formatResearchDate(source.retrievedAt)}</time></small>
          </article>
        </li>)}
      </ol> : <p className="copy-research-empty">本次研究没有保存可直接打开的公开来源。</p>}
    </>}
  </section>;
}
