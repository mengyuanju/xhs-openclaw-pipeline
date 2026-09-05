'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';

import { apiRequest } from '../components/api-client';
import {
  CopyAnalysisPromptManager,
  type CopyAnalysisPrompt,
} from './copy-analysis-prompt-manager';
import { CopyKnowledgeLibrary, type CopyKnowledgeItem } from './copy-knowledge-library';

export type { CopyKnowledgeItem } from './copy-knowledge-library';
export type { CopyAnalysisPrompt } from './copy-analysis-prompt-manager';

type LabelSummary = { name: string; itemCount: number };

export function CopyKnowledgeWorkbench({
  items,
  labels,
  prompts,
}: {
  items: CopyKnowledgeItem[];
  labels: LabelSummary[];
  prompts: CopyAnalysisPrompt[];
}) {
  const router = useRouter();
  const confirm = useConfirmDialog();
  const [sourceCopy, setSourceCopy] = useState('');
  const [analysisPrompt, setAnalysisPrompt] = useState('');
  const [selectedLabel, setSelectedLabel] = useState('ALL');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  function updateInput(setter: (value: string) => void, value: string) {
    setter(value);
    setMessage('');
  }

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!await confirm({
      title: '开始分析优秀文案？',
      description: '中心服务将调用 DeepSeek，校验分析结果后直接保存并发布到中心知识库。此操作可能产生模型费用。',
      confirmLabel: '分析并入库',
    })) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await apiRequest<{ title: string; labels: string[] }>('/api/control-plane/v1/copy-knowledge/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceCopy, analysisPrompt }),
      });
      setSourceCopy('');
      setAnalysisPrompt('');
      setSelectedLabel('ALL');
      setMessage(`“${result.title}”已由 DeepSeek 分析并按 ${result.labels.length} 个标签保存到中心知识库。`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? `分析失败：${error.message}` : '分析失败');
    } finally {
      setBusy(false);
    }
  }

  const messageIsError = message.includes('失败') || message.includes('无效');

  return <div className="stack copy-knowledge-workbench">
    <section className="panel prompt-card" aria-labelledby="copy-knowledge-heading">
      <div className="panel-head">
        <div>
          <span className="eyebrow">Copy knowledge</span>
          <h2 id="copy-knowledge-heading">优秀文案分析与分类</h2>
        </div>
        <span className="pill">新增模块</span>
      </div>
      <p className="subtle">输入一条优秀文案和分析 Prompt，中心服务会调用 DeepSeek 生成分析与分类标签，并直接保存到中心知识库。</p>
      <form className="form-grid" onSubmit={analyze}>
        <div className="field full">
          <label htmlFor="excellent-copy-source">优秀文案</label>
          <textarea
            className="textarea"
            id="excellent-copy-source"
            disabled={busy}
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
            disabled={busy}
            aria-describedby="copy-analysis-prompt-help"
            value={analysisPrompt}
            maxLength={8_000}
            placeholder="填写希望模型采用的分析维度和输出要求"
            onChange={(event) => updateInput(setAnalysisPrompt, event.target.value)}
            required
          />
          <CopyAnalysisPromptManager
            initialPrompts={prompts}
            disabled={busy}
            currentPrompt={analysisPrompt}
            onSelectPrompt={(content) => updateInput(setAnalysisPrompt, content)}
          />
        </div>
        <div className="field full inline">
          <button className="button primary" type="submit" disabled={busy || !sourceCopy.trim() || !analysisPrompt.trim()}>
            {busy ? '分析并入库中…' : 'AI 分析并直接入库'}
          </button>
          <span className="subtle">分析前会确认模型费用；模型结果校验失败时不会写入知识库。</span>
        </div>
      </form>
    </section>

    {message && <div className={messageIsError ? 'notice error' : 'notice success'} role={messageIsError ? 'alert' : 'status'} aria-live="polite">{message}</div>}

    <CopyKnowledgeLibrary items={items} labels={labels} selectedLabel={selectedLabel} onSelectLabel={setSelectedLabel} />
  </div>;
}
