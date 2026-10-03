'use client';

import { ImageCarouselNavigation } from "../components/image-carousel-navigation";
import { Checkbox, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { orderedImageFileName } from "../../src/image-file-name.mjs";
import { TaskQualitySummary } from "./task-quality-summary";
import { SecondaryAssignmentFeedbackNotice } from "./secondary-assignment-feedback";
import { ImagePreview } from "../components/image-preview";
import { AssetThumbnail } from "../components/asset-thumbnail";
import { ImagePreviewPreference } from "../components/image-preview-preference";
import { ImageManualModificationNote, IMAGE_MANUAL_MODIFICATION_NOTE_GUIDANCE, IMAGE_MANUAL_MODIFICATION_NOTE_MAX_LENGTH } from "../components/image-manual-modification-note";
import { HumanAssessmentHistory, HumanRatingFeedback, HumanScoreBadge, HumanScoreField, isPassingHumanScore } from "./human-quality-rating";
import { type TaskDetail, IMAGE_KIND_LABELS, apiPath, researchProviderLabel, researchResultLabel, TaskFailureNotice, ReworkRequirementNotice } from './task-review-model';
import type { TaskReviewViewContext } from './task-review-dialog';

export function ImageReviewPanel({ context, detail }: {
  context: Pick<TaskReviewViewContext, 'isImageReviewView' | 'imageSectionRef' | 'imageWorkMode' | 'imageActions' | 'activeReworkRequirement' | 'activeReworkReasonLabels' | 'activeReworkProblemImages' | 'assets' | 'currentImageRun' | 'selectedAsset' | 'selectedAssetIndex' | 'setSelectedAssetIndex' | 'previewBackdrop' | 'selectedAssetPage' | 'selectedAssetAlt' | 'previewTriggerRef' | 'setActiveAssetIndex' | 'imagePosition' | 'resultImageByAssetId' | 'draft' | 'research' | 'canEditImageManualNote' | 'previousImageManualModificationNote' | 'loading' | 'submitting' | 'imageManualNoteDraftRef' | 'setImageManualModificationNote' | 'previousImageManualNoteRef' | 'setPreviousImageManualModificationNote' | 'setError' | 'imageManualModificationNote' | 'savedImageManualModificationNote' | 'canReviewImages' | 'imageSetComplete' | 'humanQualitySettingsLoading' | 'humanQualitySettingsError' | 'imageScore' | 'scoreDefinitions' | 'humanQualitySettingsUnavailable' | 'savedImageAssessment' | 'updateImageScore' | 'imageReasonOptions' | 'imageReasons' | 'imageReviewNote' | 'humanRatingSettings' | 'showImageDeductionReasons' | 'toggleImageReason' | 'setImageReviewNote' | 'imageReworkTarget' | 'imageReworkCopyFields' | 'toggleReworkCopyField' | 'imageProblemAssetIds' | 'toggleProblemAsset' | 'imageScoreDefinition' | 'imageAssessments' | 'canHandleAssignedImages' | 'isAdmin' | 'imageConfigurationChanged' | 'pendingImageEdits' | 'continueImageReviewRef' | 'setPendingEditsOpen' | 'imageSettingsPanel' | 'imageHistory' | 'activeAsset' | 'activeAssetIndex' | 'activeResultImage' | 'setPreviewBackdrop'>;
  detail: TaskDetail;
}) {
  const { isImageReviewView, imageSectionRef, imageWorkMode, imageActions, activeReworkRequirement, activeReworkReasonLabels, activeReworkProblemImages, assets, currentImageRun, selectedAsset, selectedAssetIndex, setSelectedAssetIndex, previewBackdrop, selectedAssetPage, selectedAssetAlt, previewTriggerRef, setActiveAssetIndex, imagePosition, resultImageByAssetId, draft, research, canEditImageManualNote, previousImageManualModificationNote, loading, submitting, imageManualNoteDraftRef, setImageManualModificationNote, previousImageManualNoteRef, setPreviousImageManualModificationNote, setError, imageManualModificationNote, savedImageManualModificationNote, canReviewImages, imageSetComplete, humanQualitySettingsLoading, humanQualitySettingsError, imageScore, scoreDefinitions, humanQualitySettingsUnavailable, savedImageAssessment, updateImageScore, imageReasonOptions, imageReasons, imageReviewNote, humanRatingSettings, showImageDeductionReasons, toggleImageReason, setImageReviewNote, imageReworkTarget, imageReworkCopyFields, toggleReworkCopyField, imageProblemAssetIds, toggleProblemAsset, imageScoreDefinition, imageAssessments, canHandleAssignedImages, isAdmin, imageConfigurationChanged, pendingImageEdits, continueImageReviewRef, setPendingEditsOpen, imageSettingsPanel, imageHistory, activeAsset, activeAssetIndex, activeResultImage, setPreviewBackdrop } = context;
  return <section className="workbench-review-section workbench-image-review-section" data-image-primary={isImageReviewView} ref={imageSectionRef} tabIndex={-1} aria-label="当前图片审核">
              {!imageWorkMode && <div className="workbench-review-section-title workbench-image-review-section-title">
                <div className="workbench-image-review-title-main">
                  <span>{isImageReviewView ? '01' : '02'}</span>
                  <div><h3>{isImageReviewView ? detail.state === 'IMAGE_REWORK_PENDING' ? '图片返修' : '图片初审' : '图片审核'}</h3><p>{isImageReviewView
                    ? detail.state === 'IMAGE_REWORK_PENDING' ? '图片质检已打回；核对当前图集后可直接提交复检，需要后续手工修改时请填写图片审核备注。' : '由任务负责人逐页核对并修改；确认完成后提交图片抽检。'
                    : '核对当前图片运行生成的完整图集。'}</p></div>
                  {imageActions}
                </div>
              </div>}
              {!imageWorkMode && isImageReviewView && activeReworkRequirement?.source === 'IMAGE_QA' && <ReworkRequirementNotice
                title={detail.mandatoryImageQcOrigin === 'BATCH_RETURN' ? '图片质检整批打回' : '图片质检打回'}
                requirement={activeReworkRequirement}
                reasonLabels={activeReworkReasonLabels}
                problemImages={activeReworkProblemImages}
                guidance="请核对上方问题和具体要求，可直接提交当前图集进行强制图片复检；后续手工修改请在图片审核备注中写清点位。"
              />}
              {!imageWorkMode && assets.length === 0 && <p className="notice warning">当前没有可预览的图片，请刷新核对，或选择重试生图、废弃。</p>}
              {!imageWorkMode && currentImageRun?.result?.simulation?.enabled && <div className="notice warning">
                {currentImageRun.result.visualPlan?.warning?.message
                  ?? '当前图片来自联网搜索模拟，仅用于流程联调，请人工核对来源与使用范围。'}
              </div>}
              <div className="workbench-image-review-gallery">
                {imageWorkMode && assets.length === 0 && <p className="notice warning">当前没有可预览的图片，请刷新核对，或选择重新生成图片。</p>}
                {selectedAsset && <>
                  <ImageCarouselNavigation
                    currentIndex={selectedAssetIndex}
                    total={assets.length}
                    onPrevious={() => setSelectedAssetIndex(index => Math.max(0, index - 1))}
                    onNext={() => setSelectedAssetIndex(index => Math.min(assets.length - 1, index + 1))}
                  >
                    <Button unstyled className={`workbench-image-review-stage preview-background-${previewBackdrop}`} type="button" aria-label={`放大查看第 ${selectedAssetPage} 页：${selectedAssetAlt}`}
                      onClick={event => { previewTriggerRef.current = event.currentTarget; setActiveAssetIndex(selectedAssetIndex); }}>
                      <img src={apiPath(selectedAsset.url)} alt={selectedAssetAlt} decoding="async" />
                      <span>完整图 · 点击放大</span>
                    </Button>
                  </ImageCarouselNavigation>
                  {!imageWorkMode && imagePosition}
                </>}
                {assets.length > 0 && <nav className="workbench-image-review-thumbnails" aria-label="选择审核图片">
                  {assets.map((asset, index) => {
                    const resultImage = resultImageByAssetId.get(asset.id);
                    const pageIndex = resultImage?.pageIndex ?? index + 1;
                    const alt = orderedImageFileName(asset.originalName, pageIndex, asset.mediaType);
                    const markedAsProblem = activeReworkRequirement?.problemAssetIds.includes(asset.id) === true;
                    return <Button unstyled className="workbench-image-review-thumbnail" type="button" key={asset.id}
                      data-selected={selectedAssetIndex === index} data-problem={markedAsProblem || undefined} aria-pressed={selectedAssetIndex === index}
                      aria-label={`选择第 ${pageIndex} 页：${alt}`} onClick={() => setSelectedAssetIndex(index)}>
                      <AssetThumbnail src={apiPath(asset.url)} alt="" loading={index === 0 ? 'eager' : 'lazy'} />
                      <span><strong>{String(pageIndex).padStart(2, '0')}</strong>{markedAsProblem ? '质检标记问题' : IMAGE_KIND_LABELS[draft?.imagePlan[index]?.kind ?? 'detail']}</span>
                    </Button>;
                  })}
                </nav>}
              </div>
              <aside className="workbench-image-review-decision" aria-label={imageWorkMode ? '图片操作与信息' : '图片终审结论'}>
                {imageWorkMode && <SecondaryAssignmentFeedbackNotice key={`${detail.id}:${detail.secondaryAssignmentFeedback?.assignedAt ?? ''}`}
                  feedback={detail.secondaryAssignmentFeedback} />}
                {imageWorkMode && <div className="workbench-image-search-provider" aria-label="联网搜索服务">
                  <strong>联网资料搜索</strong>
                  <span>{researchResultLabel(research)} · {research?.sources?.length ?? 0} 条来源</span>
                  {research?.attempts && research.attempts.length > 1 && <small>尝试顺序：{research.attempts.map((attempt) => researchProviderLabel(attempt.provider)).join(' → ')}</small>}
                </div>}
                {isImageReviewView ? <div className="workbench-image-manual-note" role="region" aria-label="图片审核备注">
                  {canEditImageManualNote && previousImageManualModificationNote !== null && <div className="workbench-image-manual-note-previous" role="status">
                    <strong>图片版本已更新，旧版未提交的备注已保留</strong>
                    <p>请核对当前图集后选择沿用或放弃旧版备注，再继续初审。</p>
                    <p className="workbench-image-manual-note-previous-content">{previousImageManualModificationNote}</p>
                    <div className="inline">
                      <Button unstyled className="button small" type="button" disabled={loading || submitting}
                        onClick={() => {
                          const note = previousImageManualModificationNote;
                          imageManualNoteDraftRef.current = { taskId: detail.id, imageRunId: detail.currentImageRunId,
                            copyRevisionId: detail.currentCopyRevisionId, note };
                          setImageManualModificationNote(note);
                          previousImageManualNoteRef.current = null;
                          setPreviousImageManualModificationNote(null);
                          setError('');
                        }}>沿用到当前图集</Button>
                      <Button unstyled className="button small" type="button" disabled={loading || submitting}
                        onClick={() => {
                          previousImageManualNoteRef.current = null;
                          setPreviousImageManualModificationNote(null);
                          setError('');
                        }}>放弃旧版备注</Button>
                    </div>
                  </div>}
                  <label htmlFor={`image-manual-note-${detail.id}`}>图片审核备注（选填）
                    {canEditImageManualNote && <small>{[...imageManualModificationNote].length}/{IMAGE_MANUAL_MODIFICATION_NOTE_MAX_LENGTH}</small>}
                  </label>
                  <Textarea id={`image-manual-note-${detail.id}`} rows={4}
                    value={canEditImageManualNote ? imageManualModificationNote : savedImageManualModificationNote ?? ''}
                    readOnly={!canEditImageManualNote} maxLength={IMAGE_MANUAL_MODIFICATION_NOTE_MAX_LENGTH}
                    disabled={loading || submitting || previousImageManualModificationNote !== null}
                    aria-describedby={`image-manual-note-help-${detail.id}`}
                    placeholder={canEditImageManualNote
                      ? '例：第 2 页右下角产品图换成新版包装，第 3 页标题第二行修改错字。'
                      : '暂未填写图片审核备注'}
                    onChange={(event) => {
                      if (!canEditImageManualNote) return;
                      const note = event.target.value;
                      imageManualNoteDraftRef.current = { taskId: detail.id, imageRunId: detail.currentImageRunId,
                        copyRevisionId: detail.currentCopyRevisionId, note };
                      setImageManualModificationNote(note);
                      setError('');
                    }} />
                  <p id={`image-manual-note-help-${detail.id}`}>{IMAGE_MANUAL_MODIFICATION_NOTE_GUIDANCE}</p>
                  {!canEditImageManualNote && <p>此任务的图片审核备注由任务负责人填写。</p>}
                  {canEditImageManualNote && detail.state === 'IMAGE_REWORK_PENDING'
                    && <p>返修可直接提交当前图集，备注会随本次复检提交保存；如采用新图，请重新核对备注点位。</p>}
                </div> : <ImageManualModificationNote note={savedImageManualModificationNote} />}
                {imageWorkMode && <>
                  {activeReworkRequirement?.source === 'IMAGE_QA' && <ReworkRequirementNotice
                    title={detail.mandatoryImageQcOrigin === 'BATCH_RETURN' ? '图片质检整批打回' : '图片质检打回'}
                    requirement={activeReworkRequirement}
                    reasonLabels={activeReworkReasonLabels}
                    problemImages={activeReworkProblemImages}
                    guidance="请核对上方问题和具体要求，可直接提交当前图集进行强制图片复检；后续手工修改请在图片审核备注中写清点位。"
                  />}
                  <TaskFailureNotice detail={detail} />
                  {currentImageRun?.result?.simulation?.enabled && <p className="notice warning">{currentImageRun.result.visualPlan?.warning?.message
                    ?? '当前图片来自联网搜索模拟，仅用于流程联调，请人工核对来源与使用范围。'}</p>}
                  {currentImageRun?.result?.visualPlan?.warning?.message && !currentImageRun.result.simulation?.enabled
                    && <p className="notice warning">{currentImageRun.result.visualPlan.warning.message}</p>}
                </>}
                {isImageReviewView && currentImageRun && <TaskQualitySummary compact result={currentImageRun.result} />}
                {canReviewImages && <div className="human-rating-panel human-image-rating" aria-label="整套图片人工评分">
                  {!imageSetComplete && <p className="notice warning" role="status">当前图集文件不完整，不能审核通过。请刷新核对，或评分后选择重试生图、废弃。</p>}
                  {humanQualitySettingsLoading && <p className="human-rating-config-status" role="status">正在读取评分选项…</p>}
                  {humanQualitySettingsError && <p className="human-rating-config-status" role="alert">评分选项读取失败，请刷新后重试。</p>}
                  <HumanScoreField
                    id={`image-score-${detail.id}-${detail.currentImageRunId}`}
                    legend="整套图片评分"
                    value={imageScore}
                    scoreDefinitions={scoreDefinitions}
                    disabled={loading || submitting || humanQualitySettingsUnavailable || Boolean(savedImageAssessment)}
                    onChange={(score) => { updateImageScore(score); setError(''); }}
                  />
                  {imageScore !== null && <div className="human-rating-followup">
                    <HumanRatingFeedback
                      id={`image-${detail.id}-${detail.currentImageRunId}`}
                      reasonOptions={imageReasonOptions}
                      reasons={imageReasons}
                      note={imageReviewNote}
                      notePlaceholder={humanRatingSettings.noteGuidance.imagePlaceholder}
                      showReasonOptions={showImageDeductionReasons}
                      feedbackRequired={false}
                      reasonRequirement="发起返工时至少选择一项"
                      noteLabel="评分说明 / 修改要求"
                      noteRequirement="发起返工时必填"
                      disabled={loading || submitting || humanQualitySettingsUnavailable || Boolean(savedImageAssessment)}
                      onToggleReason={(code) => { toggleImageReason(code); setError(''); }}
                      onNoteChange={(note) => { setImageReviewNote(note); setError(''); }}
                    />
                    {['COPY', 'BOTH'].includes(imageReworkTarget) && <fieldset>
                      <legend>文案返工字段 <span>发起文案返工时至少选择一项</span></legend>
                      <div className="human-rating-pages">
                        {([['TITLE', '标题'], ['BODY', '正文'], ['TAGS', '标签']] as const).map(([field, label]) => <label key={field} data-selected={imageReworkCopyFields.includes(field)}>
                          <Checkbox
                            checked={imageReworkCopyFields.includes(field)}
                            disabled={loading || submitting || Boolean(savedImageAssessment)}
                            onChange={() => toggleReworkCopyField(field)}
                          />
                          <span>{label}</span>
                        </label>)}
                      </div>
                    </fieldset>}
                    {assets.length > 0 && <fieldset>
                      <legend>问题页 <span>发起图片返工时至少选择一页</span></legend>
                      <div className="human-rating-pages">
                        {assets.map((asset, index) => {
                          const pageIndex = resultImageByAssetId.get(asset.id)?.pageIndex ?? index + 1;
                          return <label key={asset.id} data-selected={imageProblemAssetIds.includes(asset.id)}>
                            <Checkbox
                              checked={imageProblemAssetIds.includes(asset.id)}
                              disabled={loading || submitting || Boolean(savedImageAssessment)}
                              onChange={() => toggleProblemAsset(asset.id)}
                            />
                            <span>第 {pageIndex} 页</span>
                          </label>;
                        })}
                      </div>
                    </fieldset>}
                  </div>}
                  {imageScore !== null && <p className="human-rating-guidance" role="status">
                    {imageScoreDefinition && <><strong>{imageScoreDefinition.title}</strong> · {imageScoreDefinition.description}。 </>}
                    {isPassingHumanScore(imageScore)
                      ? '已达到放行标准，也可根据需要重试或废弃。'
                      : '未达到放行标准，请选择重试生图或废弃。'}
                  </p>}
                  <HumanAssessmentHistory assessments={imageAssessments} scoreDefinitions={scoreDefinitions} reasonOptions={imageReasonOptions} showReasonOptions={showImageDeductionReasons} />
                </div>}
                {!canReviewImages && imageAssessments.length > 0 && <div className="human-rating-readonly">
                  <span>{imageWorkMode && detail.state === 'IMAGE_REWORK_PENDING' ? '返工要求与评分记录' : '当前图集人工评分'}</span>
                  <HumanScoreBadge score={imageAssessments.at(-1)!.score} />
                  <HumanAssessmentHistory assessments={imageAssessments} scoreDefinitions={scoreDefinitions} reasonOptions={imageReasonOptions} showReasonOptions={showImageDeductionReasons} />
                </div>}
                {!canReviewImages && imageAssessments.length === 0 && isImageReviewView && <p className="notice">{canHandleAssignedImages
                  ? detail.state === 'IMAGE_REWORK_PENDING' ? '核对当前图集后可直接提交强制图片复检，无需先在系统内修改图片；后续手工修改请填写图片审核备注。' : '请逐页核对图片。需要调整时可直接编辑或重新生成；确认无误后在底部提交图片抽检。'
                  : isAdmin ? '当前任务由其他负责人处理；如需代办，请先将任务改派给自己。' : '图片初审由任务负责人完成；质检在独立图片质检池处理抽中项。'}</p>}
                {currentImageRun?.result?.processing?.type === 'LOCAL' && <p className="notice warning">此版本已在本地转换格式或背景，未重新调用模型验收，请检查文字对比和透明边缘后审核。</p>}
                {imageConfigurationChanged && <p className="notice warning">格式与背景配置尚未应用，当前预览仍是已有成品。请先提交转换或重新生图，或刷新恢复已保存的配置。</p>}
                {pendingImageEdits.length > 0 && <div className="notice warning" role="status"><strong>还有 {pendingImageEdits.length} 个待处理的图片修改。</strong> 可集中对比并一键采用或拒绝。
                  <Button variant="outline" size="sm" type="button" disabled={submitting || loading} onClick={() => { continueImageReviewRef.current = false; setPendingEditsOpen(true); }}>集中处理修改</Button></div>}
                <div className="workbench-image-review-preference"><ImagePreviewPreference /></div>
                {imageWorkMode && <>{imageSettingsPanel}{imageHistory}</>}
              </aside>
              {activeAsset && activeAssetIndex !== null && <ImagePreview
                hideTrigger
                isOpen
                restoreFocusRef={previewTriggerRef}
                src={apiPath(activeAsset.url)}
                alt={orderedImageFileName(activeAsset.originalName, activeAssetIndex + 1, activeAsset.mediaType)}
                sourceSrc={activeResultImage?.sourceUrl ? apiPath(activeResultImage.sourceUrl) : undefined}
                deliverySrc={activeResultImage?.deliveryUrl ? apiPath(activeResultImage.deliveryUrl) : undefined}
                format={activeResultImage?.imageSettings?.format}
                transparency={activeResultImage?.transparency}
                position={activeAssetIndex + 1}
                total={assets.length}
                backdrop={previewBackdrop}
                onBackdropChange={setPreviewBackdrop}
                preloads={assets.slice(Math.max(0, activeAssetIndex - 1), activeAssetIndex + 2).filter(asset => asset.id !== activeAsset.id).map(asset => apiPath(asset.url))}
                onClose={() => { if (imageWorkMode) setSelectedAssetIndex(activeAssetIndex); setActiveAssetIndex(null); }}
                onPrevious={activeAssetIndex > 0 ? () => setActiveAssetIndex(index => index === null ? null : index - 1) : undefined}
                onNext={activeAssetIndex < assets.length - 1 ? () => setActiveAssetIndex(index => index === null ? null : index + 1) : undefined}
              />}
            </section>;
}
