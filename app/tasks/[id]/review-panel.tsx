'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type KeyboardEvent } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';

import { apiRequest } from '../../components/api-client';
import { StatusPill } from '../../components/status-pill';
import { GenerationEvidencePanel } from './generation-evidence-panel';
import { ImageGenerationBatch } from './image-generation-batch';
import { QualityIssueList } from './quality-issue-list';
import { ReviewCopyForm } from './review-copy-form';
import { buildImageBatches, qualityIssueRows, qualityReasons } from './review-presentation.mjs';

function qualityScoreLabel(score: unknown) {
  switch (score) {
    case 0: return '0 分 · 红线';
    case 1: return '1 分 · 不可用';
    case 2: return '2 分 · 可用';
    case 3: return '3 分 · 优质';
    default: return '尚未评分';
  }
}

type ExportAvailability = {
  canExport: boolean;
  reason: string | null;
};

type ReviewStage = 'copy' | 'evidence' | 'images';

export function ReviewPanel({ task, exportAvailability }: { task: any; exportAvailability: ExportAvailability }) {
  const router = useRouter();
  const confirm = useConfirmDialog();
  const current = task.currentTextRevision;
  const latestRun = task.generationRuns.at(-1);
  const batches = buildImageBatches({
    runs: task.generationRuns,
    assets: task.assets,
    currentTextRevisionId: current?.id,
  });
  const latestAssetsByPage = new Map<number, any>();
  for (const asset of task.assets) {
    if (asset.kind !== 'REFERENCE' && asset.sourceTextRevisionId === current?.id && asset.pageIndex) {
      latestAssetsByPage.set(asset.pageIndex, asset);
    }
  }
  const alignmentReady = latestAssetsByPage.size === task.config?.imageCount
    && [...latestAssetsByPage.values()].every((asset) => asset.alignmentStatus === 'PASSED');
  const approvalBlockedByQc = latestRun && ['mock_only', 'blocked'].includes(latestRun.qcDisposition);
  const failedPreview = latestRun?.status === 'FAILED' && latestAssetsByPage.size > 0;
  const approvalBlocked = Boolean(approvalBlockedByQc || !alignmentReady);
  const approvalHelp = approvalBlockedByQc
    ? `当前质检状态为 ${latestRun.qcDisposition}，不能标记为可交付；请完成真实生成。`
    : !alignmentReady
      ? '当前文案版本还没有一套完整且通过图文匹配验收的图片。'
      : '通过条件：完整图集均通过当前文案版本的图文匹配验收。';
  const currentScoreReasons = qualityReasons(latestRun);
  const currentIssues = qualityIssueRows(latestRun);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const [title, setTitle] = useState<string>(current?.title || '');
  const [body, setBody] = useState<string>(current?.body || '');
  const [tags, setTags] = useState<string>((current?.tags || []).join(' '));
  const [note, setNote] = useState('');
  const [activeStage, setActiveStage] = useState<ReviewStage>('copy');
  const reviewStages = [
    {
      id: 'copy' as const,
      index: '01',
      label: '文案定稿',
      description: '检查标题、正文与标签',
      status: `修订 #${current?.id || '—'}`,
    },
    {
      id: 'evidence' as const,
      index: '02',
      label: '生成依据',
      description: '核对来源与自动审核',
      status: latestRun ? `批次 #${latestRun.attempt || '—'}` : '暂无记录',
    },
    {
      id: 'images' as const,
      index: '03',
      label: '图片审核',
      description: '预览、质检与调整图集',
      status: `${task.assets.length} 个版本`,
    },
  ];

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage('');
    setMessageIsError(false);
    try {
      await action();
      setMessage(success);
      router.refresh();
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败');
      setMessageIsError(true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function saveText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const tagList = tags.split(/[\s,，]+/).map((tag) => tag.trim()).filter(Boolean);
    return run(() => apiRequest(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, tags: tagList }),
    }), '已保存新的文案版本；旧图片已失效，需要重新生成并通过图文匹配验收。');
  }

  async function uploadImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const succeeded = await run(() => apiRequest(`/api/tasks/${task.id}/assets`, {
      method: 'POST',
      body: new FormData(form),
    }), '参考图已上传，原文件不会被覆盖。');
    if (succeeded) form.reset();
  }

  function editImage(assetId: number, operation: any, label: string) {
    return run(() => apiRequest(`/api/tasks/${task.id}/images/${assetId}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(operation),
    }), operation.type === 'ai-edit'
      ? 'AI 编辑请求已入队，将由后台 Worker 生成新版本。'
      : `${label}完成，已生成新的图片版本。`);
  }

  async function review(status: 'APPROVED' | 'REJECTED' | 'WAITING_REVIEW') {
    if (status === 'APPROVED' && !await confirm({
      title: '通过人工审核？',
      description: '请确认文案、标签和整套图片均已检查，可以作为正式交付导出。',
      confirmLabel: '确认通过',
    })) return;
    if (status === 'REJECTED' && !note.trim()) {
      setMessage('驳回时必须填写原因。');
      setMessageIsError(true);
      return;
    }
    return run(() => apiRequest(`/api/tasks/${task.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, note }),
    }), status === 'APPROVED' ? '审核已通过。' : status === 'REJECTED' ? '已驳回并记录原因。' : '已重新打开审核。');
  }

  function moveStageFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % reviewStages.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + reviewStages.length) % reviewStages.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = reviewStages.length - 1;
    else return;

    event.preventDefault();
    const nextStage = reviewStages[nextIndex];
    setActiveStage(nextStage.id);
    document.getElementById(`review-stage-tab-${nextStage.id}`)?.focus();
  }

  return <div className="review-grid">
    <nav className="review-stage-nav" role="tablist" aria-label="审核内容分区">
      {reviewStages.map((stage, index) => <button
        className="review-stage-tab"
        id={`review-stage-tab-${stage.id}`}
        key={stage.id}
        type="button"
        role="tab"
        aria-controls={`review-stage-panel-${stage.id}`}
        aria-selected={activeStage === stage.id}
        tabIndex={activeStage === stage.id ? 0 : -1}
        onClick={() => setActiveStage(stage.id)}
        onKeyDown={(event) => moveStageFocus(event, index)}
      >
        <span className="review-stage-index" aria-hidden="true">{stage.index}</span>
        <span className="review-stage-copy"><strong>{stage.label}</strong><small>{stage.description}</small></span>
        <span className="review-stage-status">{stage.status}</span>
      </button>)}
    </nav>

    <div className="review-primary-grid">
      <aside className="stack review-decision">
        <section className="panel review-decision-panel">
          <div className="panel-head">
            <div><span className="section-kicker">人工审核</span><h2>审核结论</h2></div>
            <StatusPill value={task.config?.reviewStatus} />
          </div>

          <section className="current-score-card" aria-labelledby="current-score-title">
            <div className="current-score-head">
              <span id="current-score-title">当前评分</span>
              <strong>{qualityScoreLabel(latestRun?.qcScore)}</strong>
            </div>
            <strong className="batch-label">评分原因</strong>
            <ul className="quality-reason-list">{currentScoreReasons.map((reason: string) => <li key={reason}>{reason}</li>)}</ul>
            <QualityIssueList issues={currentIssues} />
          </section>

          <div className="field">
            <label htmlFor="review-note">审核备注 / 驳回原因</label>
            <textarea className="textarea review-note" id="review-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2_000} />
          </div>
          <div className="inline review-actions">
            <button className="button primary" type="button" disabled={busy || approvalBlocked} aria-describedby="approval-help" title={busy ? '操作处理中，请稍候' : approvalBlocked ? approvalHelp : undefined} onClick={() => review('APPROVED')}>通过</button>
            <button className="button danger" type="button" disabled={busy} title={busy ? '操作处理中，请稍候' : undefined} onClick={() => review('REJECTED')}>驳回</button>
            {task.config?.reviewStatus === 'APPROVED' && <button className="button" type="button" disabled={busy} title={busy ? '操作处理中，请稍候' : undefined} onClick={() => review('WAITING_REVIEW')}>重新打开</button>}
          </div>
          <p className="subtle review-help" id="approval-help">{approvalHelp}</p>

          <div className="review-delivery">
            <strong className="batch-label">交付文件</strong>
            {exportAvailability.canExport
              ? <a className="button" href={`/api/tasks/${task.id}/export`} download={`xhs-task-${task.id}.zip`}>导出交付包</a>
              : <button className="button" type="button" disabled aria-describedby="task-export-reason" title={exportAvailability.reason || undefined}>导出交付包</button>}
            <span className={exportAvailability.canExport ? 'subtle' : 'action-reason'} id="task-export-reason" role="note">{exportAvailability.canExport
              ? '包含当前完整文案和交付图片；待审核和已通过任务均可下载 ZIP。'
              : <>暂不可导出：{exportAvailability.reason}</>}</span>
          </div>

          {task.reviews.length > 0 && <details className="review-audit">
            <summary>查看审核记录（{task.reviews.length}）</summary>
            <div className="review-audit-list">{task.reviews.slice().reverse().map((reviewItem: any) => <div key={reviewItem.id}>
              <StatusPill value={reviewItem.status} />
              <span>{reviewItem.note || '无备注'}</span>
              <time dateTime={reviewItem.createdAt}>{new Date(reviewItem.createdAt).toLocaleString('zh-CN')}</time>
            </div>)}</div>
          </details>}
        </section>
        {message && <div className={messageIsError ? 'notice error' : 'notice success'} role={messageIsError ? 'alert' : 'status'} aria-live="polite">{message}</div>}
      </aside>

      <div className="review-content-column">
        <section
          className="review-stage-panel"
          id="review-stage-panel-copy"
          role="tabpanel"
          aria-labelledby="review-stage-tab-copy"
          hidden={activeStage !== 'copy'}
        >
          <ReviewCopyForm
            currentRevisionId={current?.id}
            title={title}
            body={body}
            tags={tags}
            busy={busy}
            onTitleChange={setTitle}
            onBodyChange={setBody}
            onTagsChange={setTags}
            onSubmit={saveText}
          />
        </section>

        <section
          className="review-stage-panel"
          id="review-stage-panel-evidence"
          role="tabpanel"
          aria-labelledby="review-stage-tab-evidence"
          hidden={activeStage !== 'evidence'}
        >
          <GenerationEvidencePanel run={latestRun} />
        </section>

        <section
          className="review-stage-panel"
          id="review-stage-panel-images"
          role="tabpanel"
          aria-labelledby="review-stage-tab-images"
          hidden={activeStage !== 'images'}
        >
          <section className="panel review-assets">
            <div className="panel-head review-assets-head">
              <div><span className="section-kicker">03 · 图片审核</span><h2>图片生成批次</h2><p className="subtle">版本、生成状态和质检结果统一收在对应批次中；点击图片进入预览、缩放和调整。</p></div>
              <span className="asset-total">{task.assets.length} 个图片版本</span>
            </div>
            {failedPreview && <div className="notice failed-preview" role="note"><strong>失败预览</strong>：质量门禁失败时保留的当次文案和图片仅供查看与修改，不可审批，也不可作为正式交付导出。</div>}
            <form className="inline upload-row" onSubmit={uploadImage}>
              <input className="input file-input upload-input" name="file" type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传参考图片" required />
              <button className="button" type="submit" disabled={busy}>上传参考图</button>
            </form>
            {batches.length === 0
              ? <div className="empty-state">还没有图片或生成运行。完成生成后会按批次显示，也可以先上传参考图。</div>
              : <div className="image-batch-list">{batches.map((batch: any) => <ImageGenerationBatch
                  key={batch.id}
                  batch={batch}
                  config={task.config}
                  visualReference={task.visualReference}
                  imageEditRequests={task.imageEditRequests}
                  busy={busy}
                  qualityScoreLabel={qualityScoreLabel}
                  onEdit={editImage}
                />)}</div>}
          </section>
        </section>
      </div>
    </div>
  </div>;
}
