'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';

import { apiRequest } from '../components/api-client';
import { StatusPill } from '../components/status-pill';

const TYPES = [
  'PHOTO_HERO', 'STEP_GUIDE', 'CHECKLIST', 'COMPARISON',
  'TIMELINE', 'TRAVEL_GUIDE', 'EMOTION_STORY', 'PRODUCT_DISPLAY',
];

const emptyDraft = {
  name: '', type: 'PHOTO_HERO', generationTarget: 'MODEL_IMAGE',
  promptTemplate: '', negativePrompt: '', styleTags: '', categories: '',
  layoutRules: '{}', qualityScore: 4, analysisModel: '', sourceImageSha256: '',
  retentionMode: 'PROMPT_ONLY', rightsStatus: 'INTERNAL_ANALYSIS_ONLY',
};

export function KnowledgeWorkbench({ items }: { items: any[] }) {
  const router = useRouter();
  const confirm = useConfirmDialog();
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<any>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  function setField(name: string, value: unknown) {
    setDraft((current: any) => ({ ...current, [name]: value }));
  }

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    if (!await confirm({
      title: '开始视觉分析？',
      description: '这会调用真实模型并可能产生费用。分析完成后，你仍可检查和修改配方再保存。',
      confirmLabel: '确认分析',
    })) return;
    setBusy(true); setMessage('');
    try {
      const data = new FormData();
      data.set('file', file);
      const result = await apiRequest<any>('/api/visual-analyses', { method: 'POST', body: data });
      const analysis = result.analysis;
      setDraft({
        ...emptyDraft,
        ...analysis,
        styleTags: analysis.styleTags.join('，'),
        categories: analysis.categories.join('，'),
        layoutRules: JSON.stringify(analysis.layoutRules, null, 2),
        sourceImageSha256: result.sourceImageSha256,
      });
      setMessage('分析完成。请检查和修改配方，再决定是否保留原图。');
    } catch (error) {
      setMessage(error instanceof Error ? `分析失败：${error.message}` : '分析失败');
    } finally { setBusy(false); }
  }

  async function saveDraft() {
    const file = fileRef.current?.files?.[0];
    setBusy(true); setMessage('');
    try {
      const payload = {
        ...draft,
        qualityScore: Number(draft.qualityScore),
        styleTags: String(draft.styleTags).split(/[，,]/u).map((value) => value.trim()).filter(Boolean),
        categories: String(draft.categories).split(/[，,]/u).map((value) => value.trim()).filter(Boolean),
        layoutRules: JSON.parse(draft.layoutRules || '{}'),
      };
      let body: BodyInit;
      let headers: HeadersInit | undefined;
      if (draft.retentionMode === 'IMAGE_AND_PROMPT') {
        if (!file) throw new Error('保留图片模式必须选择图片');
        const data = new FormData();
        data.set('data', JSON.stringify(payload));
        data.set('file', file);
        body = data;
      } else {
        body = JSON.stringify(payload);
        headers = { 'Content-Type': 'application/json' };
      }
      await apiRequest('/api/knowledge-items', { method: 'POST', headers, body });
      setMessage('配方草稿已保存；发布前不会进入生产。');
      setDraft(emptyDraft);
      if (fileRef.current) fileRef.current.value = '';
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? `保存失败：${error.message}` : '保存失败');
    } finally { setBusy(false); }
  }

  async function setStatus(item: any, status: 'PUBLISHED' | 'RETIRED') {
    const label = status === 'PUBLISHED' ? '发布并用于后续任务' : '归档并停止匹配';
    if (!await confirm({
      title: status === 'PUBLISHED' ? '发布视觉配方？' : '归档视觉配方？',
      description: `确认${label}“${item.name}”？`,
      confirmLabel: status === 'PUBLISHED' ? '确认发布' : '确认归档',
      tone: status === 'RETIRED' ? 'danger' : 'default',
    })) return;
    setBusy(true); setMessage('');
    try {
      await apiRequest(`/api/knowledge-items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      setMessage(status === 'PUBLISHED' ? '配方已发布。' : '配方已归档。');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? `操作失败：${error.message}` : '操作失败');
    } finally { setBusy(false); }
  }

  const messageIsError = message.includes('失败') || message.includes('无效');

  return <div className="stack knowledge-workbench">
    <form className="panel" onSubmit={analyze}>
      <div className="panel-head"><h2>从优秀图片提炼配方</h2><span className="subtle">PNG / JPEG / WebP · 最大 10 MiB</span></div>
      <div className="form-grid">
        <div className="field full"><label htmlFor="knowledge-image">优秀作品图片</label><input ref={fileRef} className="input file-input" id="knowledge-image" type="file" accept="image/png,image/jpeg,image/webp" required /></div>
        <div className="field full inline"><button className="button primary" type="submit" disabled={busy}>{busy ? '分析中…' : '分析图片'}</button><span className="subtle">图片文字视为不可信数据，模型只提炼视觉结构。</span></div>
      </div>
    </form>

    {draft.promptTemplate && <section className="panel">
      <div className="panel-head"><h2>检查并保存配方</h2><StatusPill value="DRAFT" /></div>
      <div className="form-grid">
        <div className="field"><label htmlFor="knowledge-name">配方名称</label><input className="input" id="knowledge-name" value={draft.name} maxLength={200} onChange={(event) => setField('name', event.target.value)} /></div>
        <div className="field">
          <label htmlFor="knowledge-type">图片类型</label>
          <Select value={draft.type} onValueChange={(value) => setField('type', value)}>
            <SelectTrigger id="knowledge-type"><SelectValue /></SelectTrigger>
            <SelectContent>{TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="field">
          <label htmlFor="knowledge-target">生成目标</label>
          <Select value={draft.generationTarget} onValueChange={(value) => setField('generationTarget', value)}>
            <SelectTrigger id="knowledge-target"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="MODEL_IMAGE">模型生成图片</SelectItem><SelectItem value="LOCAL_CARD">本地信息卡</SelectItem></SelectContent>
          </Select>
        </div>
        <div className="field"><label htmlFor="knowledge-score">人工质量分</label><input className="input" id="knowledge-score" type="number" min="1" max="5" step="0.1" value={draft.qualityScore} onChange={(event) => setField('qualityScore', event.target.value)} /></div>
        <div className="field full"><label htmlFor="knowledge-prompt">提示词模板</label><textarea className="textarea" id="knowledge-prompt" maxLength={2_000} value={draft.promptTemplate} onChange={(event) => setField('promptTemplate', event.target.value)} /></div>
        <div className="field full"><label htmlFor="knowledge-negative">负面约束</label><textarea className="textarea compact" id="knowledge-negative" maxLength={600} value={draft.negativePrompt} onChange={(event) => setField('negativePrompt', event.target.value)} /></div>
        <div className="field"><label htmlFor="knowledge-tags">风格标签（逗号分隔）</label><input className="input" id="knowledge-tags" value={draft.styleTags} onChange={(event) => setField('styleTags', event.target.value)} /></div>
        <div className="field"><label htmlFor="knowledge-categories">适用分类（逗号分隔）</label><input className="input" id="knowledge-categories" value={draft.categories} onChange={(event) => setField('categories', event.target.value)} /></div>
        <div className="field full"><label htmlFor="knowledge-layout">布局规则 JSON</label><textarea className="textarea compact mono" id="knowledge-layout" value={draft.layoutRules} onChange={(event) => setField('layoutRules', event.target.value)} /></div>
        <div className="field">
          <label htmlFor="knowledge-retention">保存方式</label>
          <Select value={draft.retentionMode} onValueChange={(value) => setField('retentionMode', value)}>
            <SelectTrigger id="knowledge-retention"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="PROMPT_ONLY">只保存提示词</SelectItem><SelectItem value="IMAGE_AND_PROMPT">保存图片和提示词</SelectItem></SelectContent>
          </Select>
        </div>
        <div className="field">
          <label htmlFor="knowledge-rights">图片授权</label>
          <Select value={draft.rightsStatus} onValueChange={(value) => setField('rightsStatus', value)}>
            <SelectTrigger id="knowledge-rights"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="INTERNAL_ANALYSIS_ONLY">仅内部分析</SelectItem>
              <SelectItem value="UNKNOWN">未知</SelectItem>
              <SelectItem value="SELF_OWNED">自有图片</SelectItem>
              <SelectItem value="LICENSED">已授权</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="field full inline"><button className="button primary" type="button" disabled={busy} onClick={saveDraft}>保存草稿</button><span className="subtle">保留图片仅允许“自有图片”或“已授权”。</span></div>
      </div>
    </section>}

    {message && <div className={messageIsError ? 'notice error' : 'notice success'} role={messageIsError ? 'alert' : 'status'} aria-live="polite">{message}</div>}

    <section className="panel">
      <div className="panel-head"><h2>视觉配方库</h2><span className="subtle">{items.length} 条</span></div>
      {items.length === 0 ? <div className="empty-state">还没有视觉配方。上传第一张优秀作品开始提炼。</div> : <div className="table-wrap mobile-cards"><table>
        <thead><tr><th>配方</th><th>类型</th><th>保存方式</th><th>质量分</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>{items.map((item) => <tr key={item.id}>
          <td data-label="配方"><strong>{item.name}</strong><div className="subtle mono">{item.latestVersion?.contentSha256?.slice(0, 10)}…</div></td>
          <td data-label="类型">{item.type}</td>
          <td data-label="保存方式">{item.retentionMode === 'PROMPT_ONLY' ? '仅提示词' : '图片 + 提示词'}</td>
          <td data-label="质量分">{item.latestVersion?.qualityScore ?? '—'}</td>
          <td data-label="状态"><StatusPill value={item.latestVersion?.status} /></td>
          <td data-label="操作"><div className="inline">{item.asset && <a className="button small" href={`/api/knowledge-assets/${item.asset.id}`} target="_blank" rel="noreferrer">查看图片</a>}{item.latestVersion?.status !== 'PUBLISHED' && item.latestVersion?.status !== 'RETIRED' && <button className="button small primary" type="button" disabled={busy} onClick={() => setStatus(item, 'PUBLISHED')}>发布</button>}{item.latestVersion?.status !== 'RETIRED' && <button className="button small" type="button" disabled={busy} onClick={() => setStatus(item, 'RETIRED')}>归档</button>}</div></td>
        </tr>)}</tbody>
      </table></div>}
    </section>
  </div>;
}
