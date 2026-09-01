type LabelSummary = { name: string; itemCount: number };

export type CopyKnowledgeItem = {
  id: number;
  title: string;
  sourceCopy: string;
  analysisPrompt: string;
  summary: string;
  analysis: string;
  labels: string[];
  createdAt: string;
};

export function CopyKnowledgeLibrary({
  items,
  labels,
  selectedLabel,
  onSelectLabel,
}: {
  items: CopyKnowledgeItem[];
  labels: LabelSummary[];
  selectedLabel: string;
  onSelectLabel: (label: string) => void;
}) {
  const visibleItems = selectedLabel === 'ALL'
    ? items
    : items.filter((item) => item.labels.includes(selectedLabel));

  return <section className="panel copy-knowledge-library" aria-labelledby="copy-knowledge-library-heading">
    <div className="panel-head">
      <div><span className="eyebrow">Classified library</span><h2 id="copy-knowledge-library-heading">文案知识库</h2></div>
      <span className="subtle">{items.length} 条</span>
    </div>
    <div className="copy-label-filter-block">
      <span className="subtle" id="copy-label-filter-label">按标签查看</span>
      <div className="copy-label-filters" role="group" aria-labelledby="copy-label-filter-label">
        <button className="button small" type="button" aria-pressed={selectedLabel === 'ALL'} onClick={() => onSelectLabel('ALL')}>全部 {items.length}</button>
        {labels.map((label) => <button className="button small" type="button" key={label.name} aria-pressed={selectedLabel === label.name} onClick={() => onSelectLabel(label.name)}>{label.name} {label.itemCount}</button>)}
      </div>
    </div>
    {visibleItems.length === 0 ? <div className="empty-state">{items.length === 0 ? '还没有文案分析。填写上方两个字段，生成第一条分类知识。' : '这个标签下还没有文案分析。'}</div> : <ul className="copy-knowledge-list">
      {visibleItems.map((item) => <li key={item.id}>
        <div className="copy-knowledge-item-head">
          <div><h3>{item.title}</h3><p>{item.summary}</p></div>
          <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN')}</time>
        </div>
        <div className="copy-knowledge-labels" aria-label="分类标签">{item.labels.map((label: string) => <span className="pill" key={label}>{label}</span>)}</div>
        <details className="copy-knowledge-details">
          <summary>查看文案、分析 Prompt 与完整结果</summary>
          <div><h4>优秀文案</h4><p>{item.sourceCopy}</p><h4>分析 Prompt</h4><p>{item.analysisPrompt}</p><h4>分析结果</h4><p>{item.analysis}</p></div>
        </details>
      </li>)}
    </ul>}
  </section>;
}
