import { summarizeImagePrompt } from './image-prompt-presentation.mjs';
import { summarizeTextPrompt } from './generation-evidence-presentation.mjs';

type PromptEntry = {
  pageIndex?: number;
  status?: string;
  content?: string | null;
};

type PromptTraceData = {
  contentKind?: string;
  text?: PromptEntry;
  images?: PromptEntry[];
};

type GenerationRun = {
  mode?: string;
  promptTrace?: PromptTraceData | null;
};

const STATUS_LABELS: Record<string, string> = {
  SUBMITTED: '已用于模型请求',
  CONFIGURED: '已生成',
  REUSED_FROM_CHECKPOINT: '断点复用',
  NOT_SUBMITTED_MOCK: 'Mock 未提交',
  NOT_SUBMITTED_MANUAL: '人工文案未提交',
  NOT_SUBMITTED: '未提交',
};

function textPromptEmptyMessage(status?: string) {
  if (status === 'NOT_SUBMITTED_MOCK') return 'Mock 批次没有向文案模型提交提示词。';
  if (status === 'NOT_SUBMITTED_MANUAL') {
    return '本批次沿用人工文案，没有调用文案生成模型。';
  }
  return '本批次未向文案模型提交提示词。';
}

function TextList({ items, empty = '未单独列出' }: { items: string[]; empty?: string }) {
  if (items.length === 0) return <span className="subtle">{empty}</span>;
  return <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}

function ImagePromptContent({ prompt }: { prompt: PromptEntry }) {
  const statusLabel = STATUS_LABELS[prompt.status || ''] || '追踪状态未记录';
  const summary = summarizeImagePrompt(prompt.content);
  const label = `第 ${prompt.pageIndex} 张图片用户提示词`;

  return <article className="prompt-content-card">
    <div className="prompt-content-meta">
      <h4>{label}</h4>
      <span className="subtle">{statusLabel}</span>
    </div>
    {!summary.available
      ? <div className="batch-empty">{summary.message}</div>
      : <div className="image-prompt-summary" aria-label={`${label}审核摘要`}>
          <div className="image-prompt-summary-head">
            <strong>{summary.page} · {summary.kind}</strong>
            <span>{summary.layout}</span>
          </div>
          <dl>
            <div><dt>视觉主体</dt><dd>{summary.visualSubject}</dd></div>
            <div><dt>构图与阅读顺序</dt><dd>{summary.layoutDirection}</dd></div>
            <div><dt>页面可见文字</dt><dd className="image-prompt-visible-copy">
              {summary.visibleText.headline && <p><strong>标题</strong>{summary.visibleText.headline}</p>}
              {summary.visibleText.subtitle && <p><strong>副标题</strong>{summary.visibleText.subtitle}</p>}
              <TextList items={summary.visibleText.bullets} empty="没有单独要点" />
              {summary.visibleText.labels.length > 0 && <p><strong>对象标签</strong>{summary.visibleText.labels.join('、')}</p>}
            </dd></div>
            <div><dt>必须呈现</dt><dd><TextList items={summary.mustShow} /></dd></div>
            <div><dt>避免出现</dt><dd><TextList items={summary.mustAvoid} /></dd></div>
            <div><dt>内容依据</dt><dd><TextList items={summary.sourceEvidence} /></dd></div>
            <div><dt>原始视觉方向</dt><dd>{summary.originalVisualDirection}</dd></div>
          </dl>
        </div>}
  </article>;
}

function RawPromptDetails({ label, content }: { label: string; content: string }) {
  return <details className="raw-prompt-details">
    <summary>查看原始提示词</summary>
    <pre className="prompt-content" tabIndex={0} aria-label={`${label}完整内容`}>{content}</pre>
  </details>;
}

function TextPromptContent({ prompt }: { prompt?: PromptEntry }) {
  const label = '文案用户提示词';
  const statusLabel = STATUS_LABELS[prompt?.status || ''] || '追踪状态未记录';
  const rawContent = prompt?.content;
  const summary = summarizeTextPrompt(rawContent);
  const emptyMessage = textPromptEmptyMessage(prompt?.status);
  return <article className="prompt-content-card">
    <div className="prompt-content-meta">
      <h4>{label}</h4>
      <span className="subtle">{statusLabel}</span>
    </div>
    {!rawContent
      ? <div className="batch-empty">{emptyMessage}</div>
      : summary.available
        ? <div className="text-prompt-summary" aria-label="文案生成请求审核摘要">
            <div className="text-prompt-summary-head">
              <div><span>本次选题</span><strong>{summary.query}</strong></div>
              <span>{summary.demandLevel} · {summary.primaryType}</span>
            </div>
            <dl>
              <div><dt>分类与受众</dt><dd>{summary.category} · {summary.targetAudience}</dd></div>
              <div><dt>生成规模</dt><dd>{summary.imageCount}</dd></div>
              <div><dt>需求判断</dt><dd>{summary.judgementReason}</dd></div>
              <div><dt>输入资料</dt><dd>联网资料 {summary.researchSourceCount} 条 · 人工链接 {summary.referenceUrlCount} 条</dd></div>
              <div><dt>补充参考文字</dt><dd>{summary.referenceText}</dd></div>
            </dl>
          </div>
        : <div className="batch-empty">{summary.message}</div>}
    {rawContent && <RawPromptDetails label={label} content={rawContent} />}
  </article>;
}

export function PromptTrace({ run }: { run?: GenerationRun | null }) {
  const promptTrace = run?.promptTrace;
  if (!promptTrace || promptTrace.contentKind !== 'USER_PROMPT') {
    return <div className="batch-empty">历史批次未单独保存用户提示词；从下一次生成开始会按批次记录。</div>;
  }
  const imagePrompts = Array.isArray(promptTrace.images) ? promptTrace.images : [];
  return <div className="prompt-content-list">
    <p className="subtle">文案和图片提示词默认显示中文审核摘要；原始文案提示词仅在折叠项中保留供技术排查。系统提示词继续在后台生效，不在审核页展示。</p>
    <TextPromptContent prompt={promptTrace.text} />
    {imagePrompts.length === 0
      ? <div className="batch-empty">{run?.mode === 'mock'
          ? 'Mock 批次没有向图片模型提交提示词。'
          : '本批次尚未记录图片用户提示词。'}</div>
      : imagePrompts.map((prompt) => <ImagePromptContent
          key={prompt.pageIndex}
          prompt={prompt}
        />)}
  </div>;
}
