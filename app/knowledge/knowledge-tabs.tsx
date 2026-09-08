'use client';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/input';

import { useRef, useState, type KeyboardEvent } from 'react';

import {
  CopyKnowledgeWorkbench,
  type CopyAnalysisPrompt,
  type CopyKnowledgeItem,
  type CopyKnowledgePagination,
} from './copy-knowledge-workbench';
import { KnowledgeWorkbench } from './knowledge-workbench';
import { apiRequest } from '../components/api-client';

type KnowledgeView = 'VISUAL' | 'COPY';
type LabelSummary = { name: string; itemCount: number };
const SHOW_KNOWLEDGE_TYPE_SWITCHER = false;

export function KnowledgeTabs({
  visualItems,
  copyItems,
  copyPagination,
  copyLabels,
  copyAnalysisPrompts,
  copySelectedLabel,
  copySearchQuery,
  knowledgeEnabled,
  remote,
}: {
  visualItems: any[];
  copyItems: CopyKnowledgeItem[];
  copyPagination: CopyKnowledgePagination;
  copyLabels: LabelSummary[];
  copyAnalysisPrompts: CopyAnalysisPrompt[];
  copySelectedLabel: string;
  copySearchQuery: string;
  knowledgeEnabled: boolean;
  remote: boolean;
}) {
  const [activeView, setActiveView] = useState<KnowledgeView>('COPY');
  const [enabled, setEnabled] = useState(knowledgeEnabled);
  const [savingEnabled, setSavingEnabled] = useState(false);
  const visualTabRef = useRef<HTMLButtonElement>(null);
  const copyTabRef = useRef<HTMLButtonElement>(null);

  function selectFromKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const nextView = activeView === 'VISUAL' ? 'COPY' : 'VISUAL';
    setActiveView(nextView);
    (nextView === 'VISUAL' ? visualTabRef : copyTabRef).current?.focus();
  }

  async function setKnowledgeEnabled(next: boolean) {
    setSavingEnabled(true);
    try {
      if (remote) {
        const settings = await apiRequest<Array<{ key: string; value: Record<string, unknown> }>>('/api/control-plane/v1/settings');
        const current = settings.find((item) => item.key === 'production')?.value ?? {};
        await apiRequest('/api/control-plane/v1/settings/production', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: { ...current, knowledgeEnabled: next } }),
        });
      } else {
        await apiRequest('/api/production-settings', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ knowledgeEnabled: next }),
        });
      }
      setEnabled(next);
    } finally {
      setSavingEnabled(false);
    }
  }

  return <div className="knowledge-hub">
    <section className="panel">
      <div className="panel-head"><div><h2>知识库使用</h2><p className="subtle">关闭后，后续任务不会引用文案案例或视觉配方；已有内容不会删除。</p></div>
        <label className="switch-field"><Switch aria-label="启用知识库" checked={enabled} disabled={savingEnabled} onChange={(event) => void setKnowledgeEnabled(event.target.checked)} /><span>{enabled ? '已启用' : '已关闭'}</span></label>
      </div>
    </section>
    {SHOW_KNOWLEDGE_TYPE_SWITCHER && <div className="knowledge-tabs" role="tablist" aria-label="知识库类型">
      <Button unstyled
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
      >视觉</Button>
      <Button unstyled
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
      >文案</Button>
    </div>}

    <section
      className="knowledge-tab-panel"
      id="knowledge-panel-visual"
      role="tabpanel"
      aria-labelledby="knowledge-tab-visual"
      hidden={activeView !== 'VISUAL'}
    >
      {SHOW_KNOWLEDGE_TYPE_SWITCHER && <div className="notice">视觉分析会调用真实模型并可能产生费用。配方必须由管理员确认发布，草稿不会进入生产任务。</div>}
      <KnowledgeWorkbench items={visualItems} />
    </section>

    <section
      className="knowledge-tab-panel"
      id="knowledge-panel-copy"
      role="tabpanel"
      aria-labelledby="knowledge-tab-copy"
      hidden={activeView !== 'COPY'}
    >
      {SHOW_KNOWLEDGE_TYPE_SWITCHER && <div className="notice">文案分析会调用真实文本模型并可能产生费用。分析结果只有在人工检查并保存后才会进入知识库。</div>}
      <CopyKnowledgeWorkbench
        items={copyItems}
        pagination={copyPagination}
        labels={copyLabels}
        prompts={copyAnalysisPrompts}
        selectedLabel={copySelectedLabel}
        searchQuery={copySearchQuery}
      />
    </section>
  </div>;
}
