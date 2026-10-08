'use client';

import { CopyMachineDraftScoreField, HumanRatingFeedback } from './human-quality-rating';
import type { TaskDetail } from './task-review-model';
import type { TaskReviewViewContext } from './task-review-dialog';

type CopyOriginalRatingContext = Pick<TaskReviewViewContext,
  'showCopyRating' | 'editable' | 'humanQualitySettingsLoading' | 'humanQualitySettingsError'
  | 'currentCopyRatingLabel' | 'copyOriginalScore' | 'showCopyScoreDescriptions' | 'loading'
  | 'submitting' | 'humanQualitySettingsUnavailable' | 'savedCopyRatings' | 'copyContentChanged'
  | 'updateCopyOriginalScore' | 'setError' | 'copyReasonOptions' | 'copyOriginalReasons'
  | 'copyOriginalNote' | 'humanRatingSettings' | 'showCopyDeductionReasons' | 'toggleReason'
  | 'setCopyOriginalReasons' | 'setCopyOriginalNote' | 'copyFeedbackRequirement'
  | 'originalCopyRatingComplete'>;

export function CopyOriginalRatingPanel({ context, detail, compact = false }: {
  context: CopyOriginalRatingContext;
  detail: TaskDetail;
  compact?: boolean;
}) {
  const { showCopyRating, editable, humanQualitySettingsLoading, humanQualitySettingsError,
    currentCopyRatingLabel, copyOriginalScore, showCopyScoreDescriptions, loading, submitting,
    humanQualitySettingsUnavailable, savedCopyRatings, copyContentChanged, updateCopyOriginalScore,
    setError, copyReasonOptions, copyOriginalReasons, copyOriginalNote, humanRatingSettings,
    showCopyDeductionReasons, toggleReason, setCopyOriginalReasons, setCopyOriginalNote,
    copyFeedbackRequirement, originalCopyRatingComplete } = context;
  if (!showCopyRating) return null;
  const needsFeedback = copyOriginalScore !== null && copyOriginalScore < 3;
  return <div className={`human-rating-panel workbench-copy-original-rating${compact ? ' workbench-copy-original-rating-compact' : ''}`} aria-label="文案人工评分">
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
    {(compact || needsFeedback) && <HumanRatingFeedback
      id={`copy-original-${detail.id}`}
      reasonOptions={copyReasonOptions}
      reasons={copyOriginalReasons}
      note={copyOriginalNote}
      notePlaceholder={humanRatingSettings.noteGuidance.copyPlaceholder}
      showReasonOptions={showCopyDeductionReasons && needsFeedback}
      feedbackRequired={needsFeedback}
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
  </div>;
}
