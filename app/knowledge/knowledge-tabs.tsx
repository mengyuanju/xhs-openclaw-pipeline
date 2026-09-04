'use client';

import { useRef, useState, type KeyboardEvent } from 'react';

import {
  CopyKnowledgeWorkbench,
  type CopyAnalysisPrompt,
  type CopyKnowledgeItem,
} from './copy-knowledge-workbench';
import { KnowledgeWorkbench } from './knowledge-workbench';

type KnowledgeView = 'VISUAL' | 'COPY';
type LabelSummary = { name: string; itemCount: number };

export function KnowledgeTabs({
  visualItems,
  copyItems,
  copyLabels,
  copyAnalysisPrompts,
}: {
  visualItems: any[];
  copyItems: CopyKnowledgeItem[];
  copyLabels: LabelSummary[];
  copyAnalysisPrompts: CopyAnalysisPrompt[];
}) {
  const [activeView, setActiveView] = useState<KnowledgeView>('VISUAL');
  const visualTabRef = useRef<HTMLButtonElement>(null);
  const copyTabRef = useRef<HTMLButtonElement>(null);

  function selectFromKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const nextView = activeView === 'VISUAL' ? 'COPY' : 'VISUAL';
    setActiveView(nextView);
    (nextView === 'VISUAL' ? visualTabRef : copyTabRef).current?.focus();
  }

  return <div className="knowledge-hub">
    <div className="knowledge-tabs" role="tablist" aria-label="知识库类型">
      <button
        ref={visualTabRef}
        className="knowledge-tab"
        id="knowledge-tab-visual"
        type="button"
        role="tab"
        aria-selected={activeView === 'VISUAL'}
        aria-controls="knowledge-panel-visual"
        tabIndex={activeView === 'VISUAL' ? 0 : -1}
        onClick={() => setActiveView('VISUAL')}
        onKeyDown={selectFromKeyboard}
      >视觉</button>
      <button
        ref={copyTabRef}
        className="knowledge-tab"
        id="knowledge-tab-copy"
        type="button"
        role="tab"
        aria-selected={activeView === 'COPY'}
        aria-controls="knowledge-panel-copy"
        tabIndex={activeView === 'COPY' ? 0 : -1}
        onClick={() => setActiveView('COPY')}
        onKeyDown={selectFromKeyboard}
      >文案</button>
    </div>

    <section
      className="knowledge-tab-panel"
      id="knowledge-panel-visual"
      role="tabpanel"
      aria-labelledby="knowledge-tab-visual"
      hidden={activeView !== 'VISUAL'}
    >
      <div className="notice">视觉分析会调用真实模型并可能产生费用。配方必须由管理员确认发布，草稿不会进入生产任务。</div>
      <KnowledgeWorkbench items={visualItems} />
    </section>

    <section
      className="knowledge-tab-panel"
      id="knowledge-panel-copy"
      role="tabpanel"
      aria-labelledby="knowledge-tab-copy"
      hidden={activeView !== 'COPY'}
    >
      <div className="notice">文案分析会调用真实文本模型并可能产生费用。分析结果只有在人工检查并保存后才会进入知识库。</div>
      <CopyKnowledgeWorkbench items={copyItems} labels={copyLabels} prompts={copyAnalysisPrompts} />
    </section>
  </div>;
}
