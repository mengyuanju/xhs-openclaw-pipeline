'use client';

import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Switch, Input } from '@/components/ui/input';
import { Disclosure, DisclosureTrigger, DisclosureContent } from '@/components/ui/disclosure';

import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../components/api-client';
import { PromptRunHistory } from './prompt-run-history';

type Policy = { schemaVersion: number; queryReviewEnabled: boolean; visualPlanningEnabled: boolean; copyKnowledgeThreshold: number;
  copyRepairTargetMin: number; copyRepairTargetMax: number; ocrMinimumConfidence: number; ocrComparison: string };
type State = { source: string; active: boolean; settings: Policy; contract: string; contractDetails?: string[]; variables: string[] };

export function PromptRuntimeSettings({ onPrepared }: { onPrepared?: () => void } = {}) {
  const [state, setState] = useState<State | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const refresh = useCallback(async () => {
    try { const result = await apiRequest<State>('/api/prompt-runtime', { cache: 'no-store' }); setState(result); setPolicy(result.settings); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '配置读取失败'); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  async function submit(drafts: boolean) {
    setBusy(true); setError(''); setMessage('');
    try {
      await apiRequest('/api/prompt-runtime', { method: drafts ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(drafts ? { action: 'PREPARE_DRAFTS' } : policy) });
      setMessage(drafts ? '候选草稿已准备，已有人工版本保持不变。请逐项编辑并发布。' : '执行配置已保存；新执行使用此配置，历史执行沿用原版本。');
      await refresh(); onPrepared?.();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '配置保存失败'); }
    finally { setBusy(false); }
  }
  return <section className="panel stack" aria-label="提示词执行配置">
    <div className="panel-head"><div><h2>执行配置</h2><p className="subtle">规则来源：{state?.source === 'CENTER' ? '中心服务' : state?.source === 'LOCAL' ? '本地离线' : '读取中'} · {state?.active ? '统一规则已启用' : '尚未启用，历史兼容规则仍在使用'}</p></div>
      <Button unstyled className="button" type="button" disabled={busy || !state} onClick={() => void submit(true)}>准备缺失的候选草稿</Button></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <div className="notice success" role="status">{message}</div>}
    {policy && <form className="stack" onSubmit={(event) => { event.preventDefault(); void submit(false); }}>
      <label className="inline"><Switch   aria-label="启用 Query 筛选" checked={policy.queryReviewEnabled} disabled={busy}
        onChange={(event) => setPolicy({ ...policy, queryReviewEnabled: event.target.checked })} />启用 Query 筛选（选题审核）</label>
      <p className="subtle">开启时先按选题审核提示词筛选，通过后生成文案；关闭后跳过这次模型审核。保存后对新执行生效，已冻结的任务沿用原配置。Excel 导入的需求强度筛选不受影响。</p>
      <label className="inline"><Switch   aria-label="启用视觉规划" checked={policy.visualPlanningEnabled} disabled={busy}
        onChange={(event) => setPolicy({ ...policy, visualPlanningEnabled: event.target.checked })} />启用视觉规划</label>
      <p className="subtle">关闭时按原配图策划直接生图。开启后仅设计画面，原标题、副标题和要点保持不变。</p>
      <div className="grid gap-4 md:grid-cols-3">
        <label className="field">案例入选分数<Input className="input" type="number" min="0" max="100" required disabled={busy} value={policy.copyKnowledgeThreshold} onChange={(e) => setPolicy({ ...policy, copyKnowledgeThreshold: Number(e.target.value) })} /></label>
        <label className="field">长度修复目标下限<Input className="input" type="number" min="400" max="600" required disabled={busy} value={policy.copyRepairTargetMin} onChange={(e) => setPolicy({ ...policy, copyRepairTargetMin: Number(e.target.value) })} /></label>
        <label className="field">长度修复目标上限<Input className="input" type="number" min="400" max="600" required disabled={busy} value={policy.copyRepairTargetMax} onChange={(e) => setPolicy({ ...policy, copyRepairTargetMax: Number(e.target.value) })} /></label>
        <label className="field">OCR 最低置信度<Input className="input" type="number" min="0" max="1" step="0.01" required disabled={busy} value={policy.ocrMinimumConfidence} onChange={(e) => setPolicy({ ...policy, ocrMinimumConfidence: Number(e.target.value) })} /></label>
        <label className="field">文字比较方式<Select disabled={busy} value={policy.ocrComparison} onValueChange={(nextValue) => setPolicy({ ...policy, ocrComparison: nextValue })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
          <SelectItem value="LINE_BREAKS_ONLY">只忽略排版换行</SelectItem><SelectItem value="LEGACY_NORMALIZED">历史宽松比较（忽略空白、引号等）</SelectItem></SelectContent></Select></label>
      </div>
      <div><Button unstyled className="button primary" disabled={busy} type="submit">{busy ? '正在保存…' : state?.active ? '保存执行配置' : '检查版本并启用统一规则'}</Button></div>
    </form>}
    {state && <Disclosure><DisclosureTrigger>查看固定契约与允许变量（只读）</DisclosureTrigger><DisclosureContent><p className="subtle">{state.contract}</p><p className="mono">{state.variables.map((value) => `{{${value}}}`).join('、')}</p>
      {state.contractDetails?.map((item) => <p className="subtle" key={item}>{item}</p>)}
      <a href="/knowledge">打开知识库管理优秀文案分析模板与视觉配方</a>
      <p className="subtle">质量修复开关、触发分数、目标分数和次数沿用生产设置。优秀文案分析沿用知识库已有分析模板。这里的草稿不是正在执行的规则。</p></DisclosureContent></Disclosure>}
    <PromptRunHistory />
  </section>;
}
