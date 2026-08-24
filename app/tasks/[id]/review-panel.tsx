'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { apiRequest } from '../../components/api-client';
import { StatusPill } from '../../components/status-pill';

export function ReviewPanel({ task }: { task: any }) {
  const router = useRouter();
  const current = task.currentTextRevision;
  const latestRun = task.generationRuns.at(-1);
  const approvalBlockedByQc = latestRun && ['mock_only', 'blocked'].includes(latestRun.qcDisposition);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState<string>(current?.title || '');
  const [body, setBody] = useState<string>(current?.body || '');
  const [tags, setTags] = useState<string>((current?.tags || []).join(' '));
  const [note, setNote] = useState('');
  const [imageInstruction, setImageInstruction] = useState('');

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true); setMessage('');
    try { await action(); setMessage(success); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(false); }
  }

  function saveText(event: FormEvent) {
    event.preventDefault();
    const tagList = tags.split(/[\s,，]+/).map((tag) => tag.trim()).filter(Boolean);
    return run(() => apiRequest(`/api/tasks/${task.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, tags: tagList }),
    }), '已保存一个新的文案版本，并重新进入待审核。');
  }

  async function uploadImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    await run(() => apiRequest(`/api/tasks/${task.id}/assets`, { method: 'POST', body: new FormData(form) }), '参考图已上传，原文件不会被覆盖。');
    form.reset();
  }

  function editImage(assetId: number, operation: any, label: string) {
    return run(() => apiRequest(`/api/tasks/${task.id}/images/${assetId}/edit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation),
    }), operation.type === 'ai-edit'
      ? 'AI 编辑请求已入队，将由后台 worker 生成新版本。'
      : `${label}完成，已生成新的图片版本。`);
  }

  function review(status: 'APPROVED' | 'REJECTED' | 'WAITING_REVIEW') {
    if (status === 'APPROVED' && !window.confirm('确认文案和图片均可交付？')) return;
    if (status === 'REJECTED' && !note.trim()) { setMessage('驳回时必须填写原因。'); return; }
    return run(() => apiRequest(`/api/tasks/${task.id}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, note }),
    }), status === 'APPROVED' ? '审核已通过。' : status === 'REJECTED' ? '已驳回并记录原因。' : '已重新打开审核。');
  }

  const messageIsError = ['失败', '必须', '不存在'].some((keyword) => message.includes(keyword));

  return <div className="review-grid">
      <form className="panel review-copy" onSubmit={saveText}>
        <div className="panel-head"><h2>文案定稿</h2><span className="subtle">当前修订 #{current?.id || '—'}</span></div>
        <div className="form-grid">
          <div className="field full"><label htmlFor="title">标题（最多 25 个可见字符）</label><input className="input" id="title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={100} /></div>
          <div className="field full"><label htmlFor="body">正文</label><textarea className="textarea" id="body" value={body} onChange={(event) => setBody(event.target.value)} required maxLength={20_000} /></div>
          <div className="field full"><label htmlFor="tags">标签（空格或逗号分隔）</label><input className="input" id="tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="#收纳 #租房生活" /></div>
          <div className="field full inline"><button className="button primary" type="submit" disabled={busy}>保存新版本</button><span className="subtle">不会覆盖上一版。</span></div>
        </div>
      </form>

      <aside className="stack review-decision">
        <section className="panel">
          <div className="panel-head"><h2>审核结论</h2><StatusPill value={task.config?.reviewStatus} /></div>
          <div className="field"><label htmlFor="review-note">审核备注 / 驳回原因</label><textarea className="textarea review-note" id="review-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2_000} /></div>
          <div className="inline review-actions"><button className="button primary" type="button" disabled={busy || approvalBlockedByQc} onClick={() => review('APPROVED')}>通过</button><button className="button danger" type="button" disabled={busy} onClick={() => review('REJECTED')}>驳回</button>{task.config?.reviewStatus === 'APPROVED' && <button className="button" type="button" disabled={busy} onClick={() => review('WAITING_REVIEW')}>重新打开</button>}</div>
          <p className="subtle review-help">{approvalBlockedByQc ? `当前质检状态为 ${latestRun.qcDisposition}，不能标记为可交付；请完成真实生成。` : '通过条件：存在当前文案版本，并且至少有一张生成或修订后的交付图片。'}</p>
        </section>
        {message && <div className={messageIsError ? 'notice error' : 'notice success'} role={messageIsError ? 'alert' : 'status'} aria-live="polite">{message}</div>}
      </aside>

      <section className="panel review-assets">
        <div className="panel-head"><h2>图片审核与修改</h2><span className="subtle">共 {task.assets.length} 个版本</span></div>
        <form className="inline upload-row" onSubmit={uploadImage}><input className="input upload-input" name="file" type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传参考图片" required /><button className="button" type="submit" disabled={busy}>上传参考图</button></form>
        <div className="field image-instruction-field"><label htmlFor="image-instruction">AI 图片修改要求（应用到你选择的图片）</label><input className="input" id="image-instruction" value={imageInstruction} onChange={(event) => setImageInstruction(event.target.value)} maxLength={1_000} placeholder="如：保留桌面主体，移除背景杂物，保持自然光" /></div>
        {task.assets.length === 0 ? <div className="empty-state">还没有图片。生成任务完成后会出现在这里，也可以先上传参考图。</div> : <div className="asset-grid">{task.assets.map((asset: any) => <article className="asset-card" key={asset.id}><img src={`/api/assets/${asset.id}`} alt={`${asset.kind} 图片版本 ${asset.revision}`} /><div className="asset-actions"><StatusPill value={asset.kind === 'REFERENCE' ? 'DRAFT' : 'COMPLETED'} /><button className="button small" type="button" disabled={busy} onClick={() => editImage(asset.id, { type: 'rotate', degrees: 90 }, '旋转')}>旋转 90°</button><button className="button small" type="button" disabled={busy} onClick={() => editImage(asset.id, { type: 'crop-3x4' }, '3:4 裁切')}>裁成 3:4</button><button className="button small" type="button" disabled={busy || !imageInstruction.trim()} onClick={() => editImage(asset.id, { type: 'ai-edit', instruction: imageInstruction }, 'AI 编辑请求入队')}>AI 图生图</button></div></article>)}</div>}
        {task.imageEditRequests.length > 0 && <div className="history image-edit-history">{task.imageEditRequests.slice().reverse().map((request: any) => <div className="history-item" key={`edit-${request.id}`}><strong>图片编辑 #{request.id}</strong> · {request.status}<div className="subtle">{request.instruction}{request.error ? ` · ${request.error}` : ''}</div></div>)}</div>}
      </section>

    <aside className="stack review-history">
      <section className="panel"><div className="panel-head"><h3>版本记录</h3></div><div className="history">{task.textRevisions.slice().reverse().map((revision: any) => <div className="history-item" key={revision.id}><strong>文案 #{revision.id} · {revision.source === 'MANUAL' ? '人工修改' : '模型生成'}</strong><div className="subtle">{revision.title}</div></div>)}{task.reviews.slice().reverse().map((reviewItem: any) => <div className="history-item" key={`review-${reviewItem.id}`}><StatusPill value={reviewItem.status} /> <span>{reviewItem.note || '无备注'}</span></div>)}</div></section>
      <section className="panel"><div className="panel-head"><h3>生成与质检</h3></div>{task.generationRuns.length === 0 ? <p className="subtle">暂无生成运行记录。</p> : <div className="history">{task.generationRuns.slice().reverse().map((run: any) => <div className="history-item" key={`run-${run.id}`}><div className="inline"><strong>第 {run.attempt} 次 · {run.mode === 'mock' ? 'Mock' : 'Live'}</strong><StatusPill value={run.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED'} /></div><div className="subtle">质检：{run.qcDisposition || '未完成'} · 分数 {run.qcScore ?? '—'}{run.error ? ` · ${run.error}` : ''}</div></div>)}</div>}</section>
      <section className="panel"><div className="panel-head"><h3>固定生产配置</h3></div><div className="history"><div className="history-item">文本提示词 <span className="mono">{task.config?.textPromptSha256?.slice(0, 12)}…</span></div><div className="history-item">图片提示词 <span className="mono">{task.config?.imagePromptSha256?.slice(0, 12)}…</span></div><div className="history-item">视觉配方 {task.visualReference ? <><strong>{task.visualReference.type}</strong> <span className="mono">v#{task.visualReference.versionId} · {task.visualReference.contentSha256?.slice(0, 10)}…</span></> : '尚未锁定'}</div><div className="history-item">目标图片数 {task.config?.imageCount || 3}</div></div></section>
    </aside>
  </div>;
}
