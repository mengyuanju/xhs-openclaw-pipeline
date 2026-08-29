import type { FormEvent } from 'react';

type ReviewCopyFormProps = {
  currentRevisionId?: number;
  title: string;
  body: string;
  tags: string;
  busy: boolean;
  onTitleChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onTagsChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function ReviewCopyForm({
  currentRevisionId,
  title,
  body,
  tags,
  busy,
  onTitleChange,
  onBodyChange,
  onTagsChange,
  onSubmit,
}: ReviewCopyFormProps) {
  return <form className="panel review-copy" onSubmit={onSubmit}>
    <div className="panel-head">
      <div><span className="section-kicker">01 · 文案</span><h2>完整文案定稿</h2></div>
      <span className="subtle">当前修订 #{currentRevisionId || '—'}</span>
    </div>
    <div className="form-grid">
      <div className="field full">
        <label htmlFor="title">标题（最多 25 个可见字符）</label>
        <input className="input review-title-input" id="title" value={title} onChange={(event) => onTitleChange(event.target.value)} required maxLength={100} />
      </div>
      <div className="field full">
        <label htmlFor="body">正文（完整展示）</label>
        <textarea className="textarea review-copy-textarea" id="body" value={body} onChange={(event) => onBodyChange(event.target.value)} required maxLength={20_000} />
      </div>
      <div className="field full">
        <label htmlFor="tags">标签（空格或逗号分隔）</label>
        <input className="input" id="tags" value={tags} onChange={(event) => onTagsChange(event.target.value)} placeholder="#收纳 #租房生活" />
      </div>
      <div className="field full inline review-save-row">
        <button className="button primary" type="submit" disabled={busy}>保存新版本</button>
        <span className="subtle">保存后保留上一版，并使旧图进入待重新验收状态。</span>
      </div>
    </div>
  </form>;
}
