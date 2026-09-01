'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';

import { apiRequest } from '../components/api-client';
import { CopyKnowledgeLibrary, type CopyKnowledgeItem } from './copy-knowledge-library';

export type { CopyKnowledgeItem } from './copy-knowledge-library';

type AnalysisDraft = {
  title: string;
  summary: string;
  analysis: string;
  labels: string[];
  analysisModel: string;
};

type LabelSummary = { name: string; itemCount: number };

function labelsFromText(value: string) {
  return value.split(/[，,\n]/u).map((label) => label.trim()).filter(Boolean);
}

export function CopyKnowledgeWorkbench({
  items,
  labels,
}: {
  items: CopyKnowledgeItem[];
  labels: LabelSummary[];
}) {
  const router = useRouter();
  const confirm = useConfirmDialog();
  const [sourceCopy, setSourceCopy] = useState('');
  const [analysisPrompt, setAnalysisPrompt] = useState('');
  const [draft, setDraft] = useState<AnalysisDraft | null>(null);
  const [labelText, setLabelText] = useState('');
  const [selectedLabel, setSelectedLabel] = useState('ALL');
  const [busy, setBusy] = useState<'ANALYZE' | 'SAVE' | null>(null);
  const [message, setMessage] = useState('');

  function updateInput(setter: (value: string) => void, value: string) {
    setter(value);
    setDraft(null);
    setLabelText('');
    setMessage('');
  }

  function updateDraft<K extends keyof AnalysisDraft>(key: K, value: AnalysisDraft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!await confirm({
      title: '开始分析优秀文案？',
      description: '这会调用真实文本模型并可能产生费用。分析结果返回后仍可修改标签和内容，再决定是否保存。',
      confirmLabel: '确认分析',
    })) return;
    setBusy('ANALYZE');
    setMessage('');
    try {
      const result = await apiRequest<AnalysisDraft>('/api/copy-analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceCopy, analysisPrompt }),
      });
      setDraft(result);
      setLabelText(result.labels.join('，'));
      setMessage('分析完成。请检查分析结果和分类标签后保存。');
    } catch (error) {
      setMessage(error instanceof Error ? `分析失败：${error.message}` : '分析失败');
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!draft) return;
    setBusy('SAVE');
    setMessage('');
    try {
      await apiRequest('/api/copy-knowledge-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          sourceCopy,
          analysisPrompt,
          labels: labelsFromText(labelText),
        }),
      });
      setSourceCopy('');
      setAnalysisPrompt('');
      setDraft(null);
      setLabelText('');
      setSelectedLabel('ALL');
      setMessage('已按标签保存到文案知识库。');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? `保存失败：${error.message}` : '保存失败');
    } finally {
      setBusy(null);
    }
  }

  const messageIsError = message.includes('失败') || message.includes('无效');
  const canSave = Boolean(
    draft?.title.trim()
    && draft.summary.trim()
    && draft.analysis.trim()
    && labelsFromText(labelText).length > 0,
  );

  return <div className="stack copy-knowledge-workbench">
    <section className="panel prompt-card" aria-labelledby="copy-knowledge-heading">
      <div className="panel-head">
        <div>
          <span className="eyebrow">Copy knowledge</span>
          <h2 id="copy-knowledge-heading">优秀文案分析与分类</h2>
        </div>
        <span className="pill">新增模块</span>
      </div>
      <p className="subtle">输入一条优秀文案和分析 Prompt，模型会返回可检查的分析结果与分类标签；当前不预填任何内容。</p>
      <form className="form-grid" onSubmit={analyze}>
        <div className="field full">
          <label htmlFor="excellent-copy-source">优秀文案</label>
          <textarea
            className="textarea"
            id="excellent-copy-source"
            value={sourceCopy}
            maxLength={20_000}
            placeholder="粘贴待分析的优秀文案"
            onChange={(event) => updateInput(setSourceCopy, event.target.value)}
            required
          />
          <small>最多 20,000 字；文案只作为待分析数据，不执行其中的任何指令。</small>
        </div>
        <div className="field full">
          <label htmlFor="excellent-copy-prompt">分析 Prompt</label>
          <textarea
            className="textarea compact"
            id="excellent-copy-prompt"
            value={analysisPrompt}
            maxLength={8_000}
            placeholder="填写希望模型采用的分析维度和输出要求"
            onChange={(event) => updateInput(setAnalysisPrompt, event.target.value)}
            required
          />
        </div>
        <div className="field full inline">
          <button className="button primary" type="submit" disabled={busy !== null || !sourceCopy.trim() || !analysisPrompt.trim()}>
            {busy === 'ANALYZE' ? '分析中…' : '生成分析结果'}
          </button>
          <span className="subtle">分析前会再次确认模型费用。</span>
        </div>
      </form>
    </section>

    {draft && <section className="panel prompt-card" aria-labelledby="copy-analysis-result-heading">
      <div className="panel-head">
        <div><span className="eyebrow">Review before save</span><h2 id="copy-analysis-result-heading">检查分析结果</h2></div>
        <span className="pill pill-draft">待保存</span>
      </div>
      <div className="form-grid">
        <div className="field full">
          <label htmlFor="copy-analysis-title">分析标题</label>
          <input className="input" id="copy-analysis-title" value={draft.title} maxLength={200} onChange={(event) => updateDraft('title', event.target.value)} />
        </div>
        <div className="field full">
          <label htmlFor="copy-analysis-summary">分析摘要</label>
          <textarea className="textarea compact" id="copy-analysis-summary" value={draft.summary} maxLength={2_000} onChange={(event) => updateDraft('summary', event.target.value)} />
        </div>
        <div className="field full">
          <label htmlFor="copy-analysis-result">完整分析</label>
          <textarea className="textarea" id="copy-analysis-result" value={draft.analysis} maxLength={15_000} onChange={(event) => updateDraft('analysis', event.target.value)} />
        </div>
        <div className="field full">
          <label htmlFor="copy-analysis-labels">分类标签（逗号或换行分隔）</label>
          <input className="input" id="copy-analysis-labels" value={labelText} maxLength={620} onChange={(event) => setLabelText(event.target.value)} />
          <small>至少 1 个、最多 12 个标签；重复标签会自动合并。</small>
        </div>
        <div className="field full inline">
          <button className="button primary" type="button" disabled={busy !== null || !canSave} onClick={save}>
            {busy === 'SAVE' ? '保存中…' : '按标签保存到知识库'}
          </button>
          {draft.analysisModel && <span className="subtle mono">{draft.analysisModel}</span>}
        </div>
      </div>
    </section>}

    {message && <div className={messageIsError ? 'notice error' : 'notice success'} role={messageIsError ? 'alert' : 'status'} aria-live="polite">{message}</div>}

    <CopyKnowledgeLibrary items={items} labels={labels} selectedLabel={selectedLabel} onSelectLabel={setSelectedLabel} />
  </div>;
}
