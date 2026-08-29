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

function PromptContent({
  label,
  content,
  status,
  emptyMessage,
}: {
  label: string;
  content?: string | null;
  status?: string;
  emptyMessage?: string;
}) {
  const statusLabel = STATUS_LABELS[status || ''] || '追踪状态未记录';
  return <article className="prompt-content-card">
    <div className="prompt-content-meta">
      <h4>{label}</h4>
      <span className="subtle">{statusLabel}</span>
    </div>
    <pre className="prompt-content" tabIndex={0} aria-label={`${label}完整内容`}>
      {content || emptyMessage || '暂无提示词内容。'}
    </pre>
  </article>;
}

export function PromptTrace({ run }: { run?: GenerationRun | null }) {
  const promptTrace = run?.promptTrace;
  if (!promptTrace || promptTrace.contentKind !== 'USER_PROMPT') {
    return <div className="batch-empty">历史批次未单独保存用户提示词；从下一次生成开始会按批次记录。</div>;
  }
  const imagePrompts = Array.isArray(promptTrace.images) ? promptTrace.images : [];
  return <div className="prompt-content-list">
    <p className="subtle">仅显示本任务的文案和逐图用户提示词；系统提示词继续在后台生效，不在审核页展示。</p>
    <PromptContent
      label="文案用户提示词"
      content={promptTrace.text?.content}
      status={promptTrace.text?.status}
      emptyMessage={textPromptEmptyMessage(promptTrace.text?.status)}
    />
    {imagePrompts.length === 0
      ? <div className="batch-empty">{run?.mode === 'mock'
          ? 'Mock 批次没有向图片模型提交提示词。'
          : '本批次尚未记录图片用户提示词。'}</div>
      : imagePrompts.map((prompt) => <PromptContent
          key={prompt.pageIndex}
          label={`第 ${prompt.pageIndex} 张图片用户提示词`}
          content={prompt.content}
          status={prompt.status}
        />)}
  </div>;
}
