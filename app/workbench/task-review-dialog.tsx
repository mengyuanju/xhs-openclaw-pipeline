'use client';

import { ImageDiscardButton } from "../components/image-discard-button";
import { TaskPriorityControl, PrioritySummary } from "./task-priority-control";
import { VisualPlanSummary } from "../components/visual-plan-summary";
import { ImagePreviewBackgroundControl } from "../components/image-preview-background-control";
import { Checkbox } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Download, Info, LoaderCircle, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import { type ReactNode } from "react";
import { DialogClose } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "@/components/ui/disclosure";
import { ToastFeedback } from "@/components/ui/sonner";
import { TaskQualitySummary } from "./task-quality-summary";
import { TaskReviewHistory, TaskReviewImageHistory, TaskReviewModelHistory } from './task-review-history';
import { ImageSettingsEditor } from "../components/image-controls";
import { LazyCurrentImageEditor as CurrentImageEditor } from "./lazy-current-image-editor";
import { PendingImageEditsDialog } from "../components/pending-image-edits-dialog";
import { copyQaDiscardReasonLabel } from "../../src/copy-qa-discard-reasons.mjs";
import { ReviewActionButton } from "./review-action-button";
import { type ImagePlanDifference, imagePlanDifferenceLabel, apiPath, ReviewReferences, TaskReviewFrame } from './task-review-model';
import { useTaskReviewController } from './use-task-review-controller';
import { CopyReviewPanel } from './copy-review-panel';
import { ImageReviewPanel } from './image-review-panel';
import { ImagePlanReviewPanel } from './image-plan-review-panel';
import { CopyOriginalRatingPanel } from './copy-original-rating-panel';

export type TaskReviewViewContext = ReturnType<typeof useTaskReviewController> & {
  imageActions: ReactNode; imagePosition: ReactNode; imageSettingsPanel: ReactNode; imageHistory: ReactNode;
};

export function TaskReviewDialog(props: Parameters<typeof useTaskReviewController>[0]) {
  const context = useTaskReviewController(props);
  const {
    selectedAsset, detail, previewBackdrop, setPreviewBackdrop, canModifyImages, assets,
    selectedAssetIndex, load, onUpdated, selectedAssetPage, selectedResultImage, selectedAssetAlt,
    draft, isCopyOnlyFinalRework, submitting, setDraft, reviseImages, embedded,
    taskId, discardChanges, copyEditNotice, ReviewTitle, role, ReviewDescription,
    taskHasAssignee, canReviewCopy, canHandleAssignedImages, isAdmin, downloadable, revision,
    aiDisclosureEnabled, editable, loading, regeneratingImagePlan, setAiDisclosureEnabled, imageWorkMode,
    isImageReviewView, submitCopyReview, mobilePane, setMobilePane, currentImageRun, imageSectionRef,
    isCopyRework, isImageRetryRework, draftSaveStatus, hasUnpersistedDraftChanges, copyReviewDraftContent, currentDraftFingerprint,
    persistCopyReviewDraft, copyOriginalScore, copyContentChanged, canApproveCopy, research, xiaohongshuLinks,
    canReviewImages, resultImageByAssetId, imageSetComplete, imageReworkTarget, imageConfigurationChanged, continueImageReviewRef,
    setPendingEditsOpen, imagePlanComparison, imagePlanChanged, error, revealImagePlanLocation, approveCopyBlockReason,
    hasUnsavedChanges, imageManualNoteChanged, submittingImagePlan, canRetryCopy, retryCopy, canRetryExhaustedImages,
    retryExhaustedImages, canResumeImages, resumeImages, canDiscardImages, setSubmitting, onOpenChange,
    canSubmitImageSelfReview, submitImageSelfReview, imageRatingComplete, submitImageReview, setImageReworkTarget, canApproveImages,
    copyActionBusyReason, saveImagePlan, canDiscardReturnedCopy, discardReturnedCopy, copyRatingBlockReason, copyRatingComplete,
    submitCopyDecision, saveCopyBlockReason, draftChanged, pendingEditsOpen, setPendingImageEdits,
  } = context;
  const compactCopyReview = Boolean(draft && !isImageReviewView && !imageWorkMode);
  const copyNotices = detail && <>
    {!!detail.copyDiscardEvents?.length && <div className="notice warning" role="status">
      <strong>文案废弃记录</strong>{detail.copyDiscardEvents.map((event, index) => <p key={index}>
        {event.source === 'COPY_QA' ? '质检直接废弃' : '质检打回后废弃'} · {copyQaDiscardReasonLabel(event.reasonCode)} · {event.note} · {event.actorUsername} · {new Date(event.createdAt).toLocaleString('zh-CN')}</p>)}
    </div>}
    {!!detail.imageDiscardEvents?.length && <div className="notice warning" role="status">
      <strong>图片环节废弃记录</strong>{detail.imageDiscardEvents.map((event, index) => <p key={index}>
        {event.note} · {event.actorUsername} · {new Date(event.createdAt).toLocaleString('zh-CN')}</p>)}
    </div>}
    {!editable && !isImageReviewView && currentImageRun && <TaskQualitySummary result={currentImageRun.result}
      onShowImages={assets.length ? () => { imageSectionRef.current?.scrollIntoView({ block: 'start' }); imageSectionRef.current?.focus({ preventScroll: true }); } : undefined} />}
    {detail.copyQaPassMode && <div className="notice" role="status">文案质检通过 · {{
      ACCOUNT_DEFAULT: '系统默认通过', HUMAN_REVIEW: '人工质检',
      BATCH_RELEASE: '批次放行', ADMIN_DIRECT: '管理员单独通过',
    }[detail.copyQaPassMode]}，已进入生图阶段。</div>}
  </>;
  const imageActions = selectedAsset && detail && <div className="workbench-image-review-title-actions">
    <ImagePreviewBackgroundControl value={previewBackdrop} onChange={setPreviewBackdrop} />
    {canModifyImages && ['MANUAL_ARCHIVE','IMAGE_REWORK_PENDING','REVIEWED'].includes(detail.state) && detail.currentImageRunId && detail.currentCopyRevisionId && <CurrentImageEditor
      key={`${detail.currentImageRunId}-${selectedAsset.id}`} taskId={detail.id} runId={detail.currentImageRunId}
      copyRevisionId={detail.currentCopyRevisionId} asset={selectedAsset} assets={assets} page={selectedAssetIndex + 1}
      runs={detail.imageRuns} onChanged={async () => {
        const next = await load();
        if (next && (next.state !== detail.state || next.currentImageRunId !== detail.currentImageRunId)) {
          await onUpdated('图片修改已采用，请重新提交图片初审。');
        }
      }} />}
  </div>;
  const imagePosition = selectedAsset && <div className="workbench-image-review-current">
    <div><strong>第 {selectedAssetPage} / {assets.length} 页</strong><span>{selectedResultImage?.provider === 'deepseek-web-image-simulation'
      ? '联网搜索模拟图'
      : selectedResultImage?.provider === 'deterministic-fallback-simulation'
        ? '本地流程联调兜底图'
        : selectedAssetAlt}</span></div>
    {selectedResultImage?.source?.pageUrl && <a href={selectedResultImage.source.pageUrl} target="_blank" rel="noreferrer">{selectedResultImage.source.title || '查看图片来源'}</a>}
  </div>;
  const imageSettingsPanel = draft && canModifyImages && <Disclosure className="workbench-review-section">
    <DisclosureTrigger>交付格式与背景</DisclosureTrigger>
    <DisclosureContent>
      <ImageSettingsEditor value={draft.imageSettings} disabled={isCopyOnlyFinalRework || submitting} onChange={imageSettings => setDraft(current => current ? { ...current, imageSettings } : current)} />
      <Button unstyled className="button" type="button" disabled={submitting || !assets.length} onClick={() => void reviseImages('REPROCESS')}>仅转换格式 / 背景（不调用模型）</Button>
    </DisclosureContent>
  </Disclosure>;
  const imageHistory = detail && <TaskReviewImageHistory key={detail.id} detail={detail}
    onRestore={canModifyImages && !submitting ? settings => setDraft(current => current ? { ...current, imageSettings: settings } : current) : undefined} />;

  const viewContext: TaskReviewViewContext = { ...context, imageActions, imagePosition, imageSettingsPanel, imageHistory };

  return <TaskReviewFrame embedded={embedded} open={taskId !== null} onOpenChange={(open) => { if (!open) void discardChanges('close'); }}>
      <ToastFeedback id="task-review-copy-edit" message={copyEditNotice?.message ?? ''}
        revision={copyEditNotice?.sequence} tone="info" />
      <header className="workbench-review-heading">
        <div>
          <span className="section-kicker">Task {detail ? `#${detail.id}` : ''}</span>
          <ReviewTitle>{detail?.state === 'REVIEWED'
            ? role === 'USER' ? '已完成任务详情' : '交付池任务详情'
            : detail?.state === 'MANUAL_ARCHIVE' ? '图片初审详情'
            : detail?.state === 'IMAGE_REWORK_PENDING' ? '图片返修详情' : embedded ? '文案作业' : '任务详情与审核'}</ReviewTitle>
          <ReviewDescription className={compactCopyReview && editable && !isCopyRework ? 'workbench-review-compact-description' : undefined}>{detail?.state === 'COPY_REVIEW_PENDING' && !taskHasAssignee
            ? '机器文案已生成；请先在任务列表分配负责人，再开始人工评分与审核。'
            : detail?.state === 'COPY_REVIEW_PENDING' && !canReviewCopy
            ? '任务已分配给其他负责人；你可以查看生成结果，但不能评分、编辑或提交审核结果。'
            : detail?.state === 'MANUAL_ARCHIVE'
            ? canHandleAssignedImages
              ? '图片已经生成；请逐页核对并按需使用完整图片编辑功能，确认后提交图片初审。'
              : isAdmin
                ? '图片初审由任务负责人完成；如需代办，请先将任务改派给自己。'
                : '图片初审由任务负责人完成；质检请在独立图片质检池处理抽中项。'
            : detail?.state === 'IMAGE_REWORK_PENDING'
              ? canHandleAssignedImages
                ? '图片已被质检打回；核对当前图集后可直接提交强制复检，无需先在系统内修改图片。后续手工修改请填写图片审核备注。'
                : isAdmin
                  ? '图片正由任务负责人返修；如需代办，请先将任务改派给自己。'
                  : '图片正由任务负责人返修；重新提交后将在图片质检池进行强制复检。'
            : detail?.state === 'REVIEWED' ? role === 'USER'
              ? '任务已经完成，可查看最终内容。'
              : downloadable
                ? '图片质检与交付门禁均已通过，可查看详情并下载完整资源包。'
                : '图片质检与交付门禁均已通过，可查看任务详情。'
            : detail?.state === 'COPY_QC_PENDING' && detail.currentStage === 'QC_MANDATORY_RECHECK'
              ? '返工稿已提交强制复检；复检通过后才会进入待生图队列。当前内容仅供查看。'
            : detail?.state === 'COPY_QC_PENDING'
              ? '当前最终稿正在等待文案质检；质检完成后才会进入待生图队列。当前内容仅供查看。'
            : detail?.state === 'COPY_FAILED'
              ? '文案生成失败；请核对失败阶段与调用记录，然后使用下方“重试文案”重新进入共享队列。'
            : detail?.state === 'COPY_RUNNING'
              ? '文案仍在执行；确认当前执行已经异常或需要作废时，可使用下方“重试文案”重新进入共享队列。'
            : '先给机器原稿评分；2 分或 2.5 分可修改正文，图片文案规划不受评分档位影响。'}</ReviewDescription>
          {revision?.approvalMode === 'ADMIN_BYPASS' && <p role="status">管理员免审核 · 当前文案已自动放行生图</p>}
        </div>
        <div className="workbench-row-actions">
          {detail && <PrioritySummary task={detail} />}
          {detail && role === 'ADMIN' && <TaskPriorityControl tasks={[detail]} onChanged={async () => { await load(); }} />}
          {detail && downloadable && <a className="button small primary" href={apiPath(`/v1/tasks/${detail.id}/archive`)} download>
            <Download size={14} />下载资源
          </a>}
          {detail && <label
            className="switch-field workbench-ai-disclosure-toggle"
            data-checked={aiDisclosureEnabled}
            title="开启后，生成图片会显示“AI生成”水印"
          >
            <Checkbox

              checked={aiDisclosureEnabled}
              disabled={!editable || isCopyOnlyFinalRework || loading || submitting || regeneratingImagePlan}
              onChange={(event) => setAiDisclosureEnabled(event.target.checked)}
            />
            <span className="workbench-ai-disclosure-switch" aria-hidden="true" />
            <span className="workbench-ai-disclosure-label">AI生成水印</span>
            <strong>{aiDisclosureEnabled ? '已开启' : '已关闭'}</strong>
          </label>}
          <Button unstyled className="button small" type="button" disabled={loading || submitting || regeneratingImagePlan} onClick={() => { void discardChanges('refresh'); }}>
            <RefreshCw className={loading ? 'animate-spin' : ''} size={14} />刷新
          </Button>
        </div>
        {imageWorkMode && <div className="workbench-image-work-toolbar" role="group" aria-label="当前图片操作">{imagePosition}{imageActions}</div>}
      </header>

      {loading && !detail
        ? <div className="workbench-review-loading"><LoaderCircle className="animate-spin" size={22} />正在读取任务详情…</div>
        : detail && <form className="workbench-review-form" data-comparing={editable} data-image-review={isImageReviewView} data-copy-layout={compactCopyReview ? 'compact' : undefined} data-work-layout={imageWorkMode ? 'image' : undefined} noValidate onSubmit={submitCopyReview}>
          {editable && <div className="workbench-review-pane-switch" aria-label="切换审核内容">
            <Button unstyled type="button" aria-pressed={mobilePane === 'copy'} aria-controls="review-copy-pane" onClick={() => setMobilePane('copy')}>文案</Button>
            <Button unstyled type="button" aria-pressed={mobilePane === 'plan'} aria-controls="review-plan-pane" onClick={() => setMobilePane('plan')}>图片文案规划</Button>
          </div>}
          <div className="workbench-review-scroll" data-mobile-pane={mobilePane}>
            {imageWorkMode && <div className="workbench-image-work-notices">{copyNotices}</div>}
            <div id="review-copy-pane" className="workbench-review-pane" data-review-pane="copy">
              {!imageWorkMode && !compactCopyReview && copyNotices}
              {!imageWorkMode && <CopyReviewPanel context={viewContext} detail={detail} compact={compactCopyReview}
                notices={compactCopyReview ? copyNotices : undefined} />}
              <div className="workbench-review-copy-additional">
              {!imageWorkMode && !editable && !compactCopyReview && <ReviewReferences detail={detail} research={research} xiaohongshuLinks={xiaohongshuLinks} isAdmin={isAdmin} />}
            {!imageWorkMode && <VisualPlanSummary value={currentImageRun?.result?.visualPlan?.value} />}
            {!imageWorkMode && currentImageRun?.result?.visualPlan?.warning?.message && !currentImageRun?.result?.simulation?.enabled
              && <p className="notice warning">{currentImageRun.result.visualPlan.warning.message}</p>}
            {(isImageReviewView || assets.length > 0 || canReviewImages) && <ImageReviewPanel context={viewContext} detail={detail} />}

            {!imageWorkMode && (!compactCopyReview || detail.imageRuns.length > 0 || detail.assets.length > 0) && imageHistory}
              </div>
            </div>

            {draft && !imageWorkMode && <ImagePlanReviewPanel context={viewContext} detail={detail} draft={draft}
              showSupportingContent={!compactCopyReview}
              ratingPanel={compactCopyReview ? <CopyOriginalRatingPanel context={viewContext} detail={detail} compact /> : undefined} />}
            {compactCopyReview && <div className="workbench-review-support" aria-label="审核参考与调用记录">
              <ReviewReferences detail={detail} research={research} xiaohongshuLinks={xiaohongshuLinks} isAdmin={isAdmin} />
              {imageSettingsPanel}
              {role === 'ADMIN' && <TaskReviewModelHistory detail={detail} research={research} revision={revision} />}
            </div>}
            {!draft && role === 'ADMIN' && <TaskReviewModelHistory detail={detail} research={research} revision={revision} />}
            <TaskReviewHistory detail={detail} admin={role === 'ADMIN'} />
          </div>

          <footer className="workbench-review-footer">
            {error && <div className="notice error workbench-review-footer-error" role="alert">
              <p>{error}</p>
              {error.startsWith('图片文案规划有 ') && imagePlanComparison?.differences.length ? <ol aria-label="未保存的图片规划差异">
                {imagePlanComparison.differences.slice(0, 3).map((difference: ImagePlanDifference, index: number) =>
                  <li key={`${difference.pageIndex}-${difference.field}-${difference.bulletIndex ?? ''}-${index}`}>
                    <Button unstyled className="button small" type="button" onClick={() => revealImagePlanLocation(difference)}>
                      {imagePlanDifferenceLabel(difference)}
                    </Button>
                  </li>)}
              </ol> : null}
            </div>}
            {editable && approveCopyBlockReason && <p className="workbench-review-action-hint" role="status">
              <Info size={15} aria-hidden="true" /><span>{approveCopyBlockReason}</span>
            </p>}
            <span><strong className="workbench-review-dirty" role="status">{hasUnsavedChanges
              ? imageManualNoteChanged ? '图片审核备注尚未提交 · '
                : hasUnpersistedDraftChanges || draftSaveStatus === 'saving' ? '有未保存草稿 · ' : '草稿已保存，尚未提交 · '
              : ''}</strong>{imageWorkMode ? `当前图集 · ${assets.length} 页` : editable
              ? copyContentChanged || isCopyRework && imagePlanChanged ? `保存后将创建人工修订版 v${(revision?.revision ?? 0) + 1}` : `当前文案版本 v${revision?.revision ?? '—'} · ${isCopyRework ? '等待提交强制复检' : '等待评分决定'}`
              : `当前文案版本 v${revision?.revision ?? '—'}`}</span>
            <div>
              {embedded ? <Button unstyled className="button" type="button" disabled={submitting || submittingImagePlan || draftSaveStatus === 'saving'} onClick={() => { void discardChanges('close'); }}>暂跳过</Button>
                : <DialogClose asChild><Button unstyled className="button" type="button" disabled={submitting || submittingImagePlan || draftSaveStatus === 'saving'}>{regeneratingImagePlan && !submittingImagePlan ? '关闭，后台继续处理' : '关闭'}</Button></DialogClose>}
              {embedded && editable && <Button unstyled className="button" type="button" disabled={submitting || loading || draftSaveStatus === 'saving' || !hasUnpersistedDraftChanges}
                onClick={() => { if (copyReviewDraftContent && currentDraftFingerprint) void persistCopyReviewDraft(copyReviewDraftContent, currentDraftFingerprint); }}><Save size={15} />保存草稿</Button>}
              {canModifyImages && <Button unstyled className="button primary" type="button" disabled={submitting} onClick={() => void reviseImages('REGENERATE')}><RotateCcw size={15} />重新生成图片</Button>}
              {canRetryCopy && <Button unstyled className="button primary" type="button" disabled={submitting || loading} onClick={() => { void retryCopy(); }}><RotateCcw size={15} />重试文案</Button>}
              {canRetryExhaustedImages && <Button unstyled className="button primary" type="button" disabled={submitting || loading || draftSaveStatus === 'saving'} onClick={() => { void retryExhaustedImages(); }}><RotateCcw size={15} />重试生图</Button>}
              {role === 'ADMIN' && detail.state === 'COPY_QC_PENDING'
                && <a className="button primary" href="/copy-qa">进入质检批次</a>}
              {canResumeImages && <Button unstyled className="button primary" type="button" disabled={submitting || loading} onClick={() => { void resumeImages(); }}><RotateCcw size={15} />从失败步骤继续</Button>}
              {canDiscardImages && detail.currentImageRunId && detail.currentCopyRevisionId && <ImageDiscardButton
                target={{ taskId: detail.id, imageRunId: detail.currentImageRunId, copyRevisionId: detail.currentCopyRevisionId }}
                disabled={submitting || loading || submittingImagePlan} onBusyChange={setSubmitting}
                onCompleted={async () => { await onUpdated(`任务 #${detail.id} 已废弃，原因已记录。`, detail.id); onOpenChange(false); }} />}
              {canSubmitImageSelfReview && <Button unstyled className="button primary" type="button"
                disabled={submitting || loading || !imageSetComplete || imagePlanChanged || imageConfigurationChanged}
                onClick={() => { void submitImageSelfReview(); }}><CheckCircle2 size={15} />
                {submitting ? '正在提交…' : embedded ? '提交并下一条'
                  : detail.state === 'IMAGE_REWORK_PENDING' || detail.mandatoryImageQc ? '提交图片复检' : '初审完成，提交图片抽检'}</Button>}
              {canReviewImages && <>
                <Button unstyled className="button danger" type="button" disabled={submitting || loading || !imageRatingComplete} onClick={() => { void submitImageReview('DISCARD'); }}><Trash2 size={15} />废弃</Button>
                <div className="workbench-image-rework-control">
                  <Select value={imageReworkTarget} disabled={submitting || loading} onValueChange={(value: 'COPY' | 'IMAGE' | 'BOTH') => setImageReworkTarget(value)}>
                    <SelectTrigger aria-label="返工范围"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="IMAGE">仅图片返工</SelectItem>
                      <SelectItem value="COPY">仅文案返工</SelectItem>
                      <SelectItem value="BOTH">文案 + 图片返工</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button unstyled className="button" type="button" disabled={submitting || loading || !imageRatingComplete} onClick={() => { void submitImageReview('REWORK', imageReworkTarget); }}><RotateCcw size={15} />发起返工</Button>
                </div>
                <Button unstyled className="button primary" type="button" disabled={submitting || loading || !canApproveImages} onClick={() => { void submitImageReview('APPROVE'); }}><CheckCircle2 size={15} />{submitting ? '正在提交…' : '通过到交付池'}</Button>
              </>}
              {editable && <>
                {imagePlanChanged && !isImageRetryRework && <ReviewActionButton unstyled className="button" type="button" disabled={submitting || loading || regeneratingImagePlan}
                  disabledReason={copyActionBusyReason}
                  onClick={(event) => { if (event.currentTarget.form) void saveImagePlan(event.currentTarget.form); }}>
                  <Save size={15} />{submitting ? '正在保存…' : '单独保存图片规划'}
                </ReviewActionButton>}
                {canDiscardReturnedCopy && <ReviewActionButton unstyled className="button danger" type="button"
                  disabledReason={copyActionBusyReason}
                  disabled={submitting || loading || regeneratingImagePlan || draftSaveStatus === 'saving'} onClick={() => { void discardReturnedCopy(); }}>
                  <Trash2 size={15} />{revision?.reworkRecommendation === 'DISCARD' ? '确认质检建议并废弃' : '废弃返工任务'}
                </ReviewActionButton>}
                {!isCopyRework && copyOriginalScore === 1 && <ReviewActionButton unstyled className="button danger" type="button" disabledReason={copyActionBusyReason || copyRatingBlockReason} disabled={submitting || loading || regeneratingImagePlan || draftSaveStatus === 'saving' || !copyRatingComplete} onClick={(event) => { if (event.currentTarget.form) void submitCopyDecision('DISCARD', event.currentTarget.form); }}><Trash2 size={15} />评分并废弃</ReviewActionButton>}
                {!isImageRetryRework && (isCopyRework || copyOriginalScore !== 1) && <ReviewActionButton unstyled className="button" type="button" disabledReason={saveCopyBlockReason} disabled={submitting || loading || regeneratingImagePlan || draftSaveStatus === 'saving' || !copyRatingComplete || isCopyRework && !draftChanged} onClick={(event) => { if (event.currentTarget.form) void submitCopyDecision('SAVE', event.currentTarget.form); }}>
                  {submitting ? <><LoaderCircle className="animate-spin" size={15} />正在提交…</> : isCopyRework ? detail.copyQaReworkPending ? '保存返工稿，暂不提交审核' : '保存返工稿，暂不提交复检' : '保存评分，暂不提交'}
                </ReviewActionButton>}
                <ReviewActionButton unstyled className="button primary" type="submit" disabledReason={approveCopyBlockReason} disabled={submitting || loading || regeneratingImagePlan || draftSaveStatus === 'saving' || !canApproveCopy}>
                  {submitting ? <><LoaderCircle className="animate-spin" size={15} />正在提交…</> : <><CheckCircle2 size={15} />{detail.copyQaReworkPending ? embedded ? '提交审核并下一条' : '审核通过并进入待成批' : isImageRetryRework ? embedded ? '提交修订并下一条' : '提交修订并强制复检' : embedded ? isCopyRework ? '提交复检并下一条' : '提交并下一条' : isCopyRework ? '提交强制复检' : '审核通过并进入后续流程'}</>}
                </ReviewActionButton>
              </>}
            </div>
          </footer>
        </form>}

      {detail?.currentImageRunId && detail.currentCopyRevisionId && <PendingImageEditsDialog
        key={`${detail.id}-${detail.currentImageRunId}`}
        taskId={detail.id} imageRunId={detail.currentImageRunId} copyRevisionId={detail.currentCopyRevisionId}
        currentPages={assets.map((asset, index) => ({ assetId: asset.id, page: resultImageByAssetId.get(asset.id)?.pageIndex ?? index + 1 }))}
        open={pendingEditsOpen} onOpenChange={setPendingEditsOpen} onBusyChange={setSubmitting}
        onRefreshTask={async () => { if (!await load()) throw new Error('任务刷新失败，请重试'); }}
        onResolved={async remaining => {
          const next = await load();
          if (!next) throw new Error('修改已处理，刷新图集失败，请刷新后继续初审');
          setPendingImageEdits(remaining);
          if (remaining.length === 0) {
            setPendingEditsOpen(false);
            if (continueImageReviewRef.current) {
              continueImageReviewRef.current = false;
              await submitImageSelfReview(next, true);
            }
          }
        }} />}
      {error && !detail && <div className="notice error workbench-review-error" role="alert">{error}</div>}
  </TaskReviewFrame>;
}
