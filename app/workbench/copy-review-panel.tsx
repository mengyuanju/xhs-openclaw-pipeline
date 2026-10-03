'use client';

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { History, LoaderCircle, RotateCcw, Save } from "lucide-react";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "@/components/ui/disclosure";
import { SecondaryAssignmentFeedbackNotice } from "./secondary-assignment-feedback";
import { COPY_MACHINE_DRAFT_SCORE_PRESENTATION, CopyMachineDraftScoreField, HumanAssessmentHistory, HumanRatingFeedback, HumanScoreBadge } from "./human-quality-rating";
import styles from "./copy-review-drafts.module.css";
import { copyReviewDraftFingerprint } from "./copy-review-draft-store";
import { type TaskDetail, ReviewScrollTextarea, TaskFailureNotice, ReworkRequirementNotice } from './task-review-model';
import type { TaskReviewViewContext } from './task-review-dialog';

export function CopyReviewPanel({ context, detail }: {
  context: Pick<TaskReviewViewContext, 'isImageReviewView' | 'editable' | 'isCopyRework' | 'role' | 'taskHasAssignee' | 'canReviewCopy' | 'isImageRetryRework' | 'activeReworkRequirement' | 'revision' | 'activeReworkReasonLabels' | 'activeReworkProblemImages' | 'draftSaveStatus' | 'hasUnpersistedDraftChanges' | 'lastDraftSavedAt' | 'regeneratingImagePlan' | 'copyReviewDraftContent' | 'currentDraftFingerprint' | 'persistCopyReviewDraft' | 'restoreCurrentCopyRevision' | 'draftSaveError' | 'draftHistory' | 'restoredDraftId' | 'restoreDraftVersion' | 'draft' | 'copyEditBlockMessage' | 'copyEditPointerAtRef' | 'revealCopyEditNotice' | 'copyFieldsReadOnly' | 'updateCopy' | 'mobilePane' | 'showCopyRating' | 'humanQualitySettingsLoading' | 'humanQualitySettingsError' | 'currentCopyRatingLabel' | 'copyOriginalScore' | 'showCopyScoreDescriptions' | 'loading' | 'submitting' | 'humanQualitySettingsUnavailable' | 'savedCopyRatings' | 'copyContentChanged' | 'updateCopyOriginalScore' | 'setError' | 'copyReasonOptions' | 'copyOriginalReasons' | 'copyOriginalNote' | 'humanRatingSettings' | 'showCopyDeductionReasons' | 'toggleReason' | 'setCopyOriginalReasons' | 'setCopyOriginalNote' | 'copyFeedbackRequirement' | 'originalCopyRatingComplete' | 'copyAssessments' | 'canApproveCopy' | 'copyReworkSatisfied' | 'scoreDefinitions'>;
  detail: TaskDetail;
}) {
  const { isImageReviewView, editable, isCopyRework, role, taskHasAssignee, canReviewCopy, isImageRetryRework, activeReworkRequirement, revision, activeReworkReasonLabels, activeReworkProblemImages, draftSaveStatus, hasUnpersistedDraftChanges, lastDraftSavedAt, regeneratingImagePlan, copyReviewDraftContent, currentDraftFingerprint, persistCopyReviewDraft, restoreCurrentCopyRevision, draftSaveError, draftHistory, restoredDraftId, restoreDraftVersion, draft, copyEditBlockMessage, copyEditPointerAtRef, revealCopyEditNotice, copyFieldsReadOnly, updateCopy, mobilePane, showCopyRating, humanQualitySettingsLoading, humanQualitySettingsError, currentCopyRatingLabel, copyOriginalScore, showCopyScoreDescriptions, loading, submitting, humanQualitySettingsUnavailable, savedCopyRatings, copyContentChanged, updateCopyOriginalScore, setError, copyReasonOptions, copyOriginalReasons, copyOriginalNote, humanRatingSettings, showCopyDeductionReasons, toggleReason, setCopyOriginalReasons, setCopyOriginalNote, copyFeedbackRequirement, originalCopyRatingComplete, copyAssessments, canApproveCopy, copyReworkSatisfied, scoreDefinitions } = context;
  return <section className="workbench-review-section workbench-copy-review-section">
                <div className="workbench-review-section-title"><span>{isImageReviewView ? '02' : '01'}</span><div><h3>{isImageReviewView ? '已审文案对照' : '标题、正文与标签'}</h3><p>{editable
                  ? isCopyRework
                    ? '按返工原因修改标题、正文或标签；无需重新评分。实际修改后提交强制复检，复检通过后才会进入待生图队列。'
                    : '先评价机器原稿，再决定提交达标审核结果或修改。'
                  : isImageReviewView
                    ? '文案已完成前序审核，保留标题、正文与标签用于核对图片表达。'
                  : detail.currentStage === 'QC_MANDATORY_RECHECK'
                    ? '返工稿已提交强制复检；复检通过后才会进入待生图队列。'
                    : '当前状态只读，展示任务采用的文案版本。'}</p></div></div>
                <div className="workbench-review-query" aria-label="原始需求">
                  <strong>原始需求</strong>
                  <div className="workbench-review-query-text">{detail.query}</div>
                  {role !== 'USER' && <span>词包：{detail.sourceQueryPackageName || '未归属词包'}</span>}
                </div>
                {detail.state === 'COPY_REVIEW_PENDING' && !taskHasAssignee
                  && <div className="notice warning" role="status">文案已生成，但任务尚未分配负责人。请先关闭窗口并完成分配，再进行评分或修改。</div>}
                {detail.state === 'COPY_REVIEW_PENDING' && taskHasAssignee && !canReviewCopy
                  && <div className="notice warning" role="status">当前任务由其他负责人处理；这里仅提供只读查看。</div>}
              {editable && isCopyRework && (isImageRetryRework
                ? <div className="notice warning" role="status"><strong>生图失败处理</strong><br />请核对上方失败原因。当前文案与规划无须修改时，任务负责人或管理员可直接重试生图；需要调整内容时，修改后提交强制复检。</div>
                : activeReworkRequirement
                  ? <ReworkRequirementNotice
                      title={`${activeReworkRequirement.source === 'IMAGE_QA' ? '图片质检打回' : '文案抽检返工'}${revision?.reworkRecommendation === 'DISCARD' ? ' · 质检建议废弃' : ''}`}
                      requirement={activeReworkRequirement}
                      reasonLabels={activeReworkReasonLabels}
                      problemImages={activeReworkProblemImages}
                      guidance={revision?.reworkRecommendation === 'DISCARD'
                        ? '可以继续返工，也可以由当前任务负责人确认废弃；质检建议本身不会直接终止任务。'
                        : '请按上方范围、问题标签和具体要求修改；完成实际修改后直接提交强制复检，无需先单独保存。'}
                    />
                  : <div className="notice warning" role="status"><strong>返工要求</strong><br />请按质检要求完成实际修改后提交强制复检。</div>)}
                <TaskFailureNotice detail={detail} />
                <SecondaryAssignmentFeedbackNotice key={`${detail.id}:${detail.secondaryAssignmentFeedback?.assignedAt ?? ''}`}
                  feedback={detail.secondaryAssignmentFeedback} />
                {editable && <Disclosure className={styles.panel}>
                  <DisclosureTrigger className={styles.trigger}>
                    <span><History size={16} /><strong>审核草稿</strong></span>
                    <small>{draftSaveStatus === 'saving'
                      ? '正在保存…'
                      : draftSaveStatus === 'error'
                        ? '保存失败'
                        : hasUnpersistedDraftChanges
                          ? '等待自动保存'
                          : lastDraftSavedAt
                            ? `已保存 ${new Date(lastDraftSavedAt).toLocaleString('zh-CN', { hour12: false })}`
                            : '修改后自动保存到此浏览器'}</small>
                  </DisclosureTrigger>
                  <DisclosureContent className={styles.content}>
                    <div className={styles.actions}>
                      <div>
                        <strong>本机草稿历史</strong>
                        <small>按当前文案版本和你的账号保存在此浏览器，最多保留 7 天。清除网站数据或更换浏览器后无法恢复。</small>
                      </div>
                      <Button unstyled className="button small" type="button"
                        disabled={regeneratingImagePlan || !hasUnpersistedDraftChanges || draftSaveStatus === 'saving' || !copyReviewDraftContent || !currentDraftFingerprint}
                        onClick={() => {
                          if (copyReviewDraftContent && currentDraftFingerprint) {
                            void persistCopyReviewDraft(copyReviewDraftContent, currentDraftFingerprint);
                          }
                        }}>
                        {draftSaveStatus === 'saving' ? <LoaderCircle className="animate-spin" size={14} /> : <Save size={14} />}
                        立即保存
                      </Button>
                      <Button unstyled className="button small" type="button"
                        disabled={regeneratingImagePlan || draftSaveStatus === 'saving'} onClick={() => { void restoreCurrentCopyRevision(); }}>
                        <RotateCcw size={14} />恢复正式版本
                      </Button>
                    </div>
                    {draftSaveError && <div className="notice error" role="alert">{draftSaveError}</div>}
                    {draftHistory.length > 0
                      ? <ol className={styles.history}>{draftHistory.map(item => <li key={item.id} data-current={item.id === restoredDraftId}>
                        <div>
                          <strong>草稿 v{item.version}</strong>
                          <span>{item.content.draft.copy.title || '未填写标题'}</span>
                          <small>{new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}</small>
                        </div>
                        <Button unstyled className="button small" type="button"
                          disabled={regeneratingImagePlan || draftSaveStatus === 'saving' || item.id === restoredDraftId && copyReviewDraftFingerprint(item.content) === currentDraftFingerprint}
                          onClick={() => { void restoreDraftVersion(item); }}>
                          {item.id === restoredDraftId && copyReviewDraftFingerprint(item.content) === currentDraftFingerprint ? '当前版本' : '恢复'}
                        </Button>
                      </li>)}</ol>
                      : <div className={styles.empty}>还没有历史草稿。开始修改后会自动生成第一个版本。</div>}
                  </DisclosureContent>
                </Disclosure>}
                {draft ?
                <div className="workbench-copy-fields" data-edit-blocked={Boolean(copyEditBlockMessage)}
                  onPointerDownCapture={() => { copyEditPointerAtRef.current = Date.now(); }}
                  onClickCapture={() => revealCopyEditNotice('copy')}
                  onFocusCapture={() => { if (Date.now() - copyEditPointerAtRef.current > 500) revealCopyEditNotice('copy'); }}>
                  <div className="field full">
                    <label htmlFor="review-copy-title">标题 <small>{draft.copy.title.length}/25</small></label>
                    <Input id="review-copy-title" className="input" value={draft.copy.title} maxLength={25} required readOnly={copyFieldsReadOnly}
                      onChange={(event) => updateCopy('title', event.target.value)} />
                  </div>
                  <div className="field full">
                    <label htmlFor="review-copy-body">正文 <small>{[...draft.copy.body].length}/400–600</small></label>
                    <ReviewScrollTextarea id="review-copy-body" className="textarea workbench-copy-body-editor" value={draft.copy.body} minLength={400} maxLength={600} required readOnly={copyFieldsReadOnly}
                      resizeToken={mobilePane === 'copy'} onChange={(event) => updateCopy('body', event.target.value)} />
                  </div>
                  <div className="field full">
                    <label htmlFor="review-copy-tags">标签 <small>3–8 个，用空格分隔</small></label>
                    <Input id="review-copy-tags" className="input" value={draft.copy.tags.join(' ')} required readOnly={copyFieldsReadOnly}
                      onChange={(event) => updateCopy('tags', event.target.value)} />
                  </div>
                </div> : <div className="workbench-review-empty">当前任务还没有可审核的文案版本。</div>}
                {showCopyRating && <div className="human-rating-panel" aria-label="文案人工评分">
                  {!editable && <p className="human-rating-config-status" role="status">评分模块当前为只读。请确认任务已分配给当前账号，并刷新任务详情后再评分。</p>}
                  {humanQualitySettingsLoading && <p className="human-rating-config-status" role="status">正在读取评分选项…</p>}
                  {humanQualitySettingsError && <p className="human-rating-config-status" role="alert">评分选项读取失败，请刷新后重试。</p>}
                  <CopyMachineDraftScoreField
                    id={`copy-original-score-${detail.id}`}
                    legend={currentCopyRatingLabel}
                    value={copyOriginalScore}
                    showDescriptions={showCopyScoreDescriptions}
                    disabled={!editable || loading || submitting || humanQualitySettingsUnavailable || Boolean(savedCopyRatings.current) || copyContentChanged}
                    onChange={(score) => { updateCopyOriginalScore(score); setError(''); }}
                  />
                  {copyOriginalScore !== null && copyOriginalScore < 3 && <HumanRatingFeedback
                    id={`copy-original-${detail.id}`}
                    reasonOptions={copyReasonOptions}
                    reasons={copyOriginalReasons}
                    note={copyOriginalNote}
                    notePlaceholder={humanRatingSettings.noteGuidance.copyPlaceholder}
                    showReasonOptions={showCopyDeductionReasons}
                    disabled={!editable || loading || submitting || humanQualitySettingsUnavailable || Boolean(savedCopyRatings.current)}
                    onToggleReason={(code) => { toggleReason(code, setCopyOriginalReasons); setError(''); }}
                    onNoteChange={(note) => { setCopyOriginalNote(note); setError(''); }}
                  />}
                  {copyOriginalScore !== null && <p className="human-rating-guidance" role="status">
                    {copyOriginalScore === 1
                      ? `填写${copyFeedbackRequirement}后，只能评分并废弃任务。`
                      : copyOriginalScore === 2
                        ? `已解锁标题、正文与标签编辑；${originalCopyRatingComplete ? '修改完成后可提交审核结果' : `提交前请填写${copyFeedbackRequirement}`}。人工确认达标后，系统将最终修改稿记录为 3 分，原评分保持不变。`
                      : copyOriginalScore === 2.5
                        ? `请完成必要的小修；${originalCopyRatingComplete ? '修改完成后可提交审核结果' : `提交前请填写${copyFeedbackRequirement}`}。人工确认达标后，系统将最终修改稿记录为 3 分，原评分保持不变。`
                        : '原稿已达标，可直接提交审核结果；后续将按任务策略进入文案抽检或待生图队列。'}
                  </p>}
                </div>}
                {!editable && copyAssessments.length > 0 && <div className="human-rating-readonly">
                  <span>当前文案人工评分</span>
                  <HumanScoreBadge score={copyAssessments.at(-1)!.score}
                    passingScores={copyAssessments.at(-1)!.ratingContext === 'ORIGINAL'
                      ? COPY_MACHINE_DRAFT_SCORE_PRESENTATION.passingScores : undefined} />
                </div>}
                {editable && canApproveCopy && <div className="workbench-final-score-card" role="status" aria-label="最终稿评分">
                  <div><span>最终稿评分</span><HumanScoreBadge score={3} passingScores={COPY_MACHINE_DRAFT_SCORE_PRESENTATION.passingScores} /></div>
                  <p>{copyOriginalScore === 3 && !copyContentChanged
                    ? '机器原稿已达标，本次审核结果为 3 分。'
                    : '提交达标后系统自动把最终修改稿记录为 3 分，并保留机器原稿评分与原因。'}</p>
                </div>}
                {editable && (isCopyRework ? copyReworkSatisfied : copyContentChanged) && <div className="notice success" role="status">{isCopyRework
                  ? '返工稿无需再次评分；提交强制复检时，系统会将最终稿记录为 3 分。复检通过后才会进入待生图队列。'
                  : '最终修改稿无需再次评分；提交达标审核结果时，系统会将其记录为 3 分，机器原稿评分和原因继续保留。'}</div>}
                <HumanAssessmentHistory assessments={copyAssessments} scoreDefinitions={scoreDefinitions} reasonOptions={copyReasonOptions}
                  originalScorePresentation={COPY_MACHINE_DRAFT_SCORE_PRESENTATION}
                  showScoreDescriptions={showCopyScoreDescriptions} showReasonOptions={showCopyDeductionReasons} />
              </section>;
}
