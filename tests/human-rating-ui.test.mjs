import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test('shared image rating keeps its passing rule while copy machine drafts use dedicated semantics', async () => {
  const [rating, settings, qualitySummary, styles] = await Promise.all([
    readFile(projectFile('app/workbench/human-quality-rating.tsx'), 'utf8'),
    readFile(projectFile('src/human-quality-settings.mjs'), 'utf8'),
    readFile(projectFile('app/workbench/task-quality-summary.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(settings, /HUMAN_QUALITY_SCORES = Object\.freeze\(\[1, 2, 2\.5, 3\]\)/u);
  assert.match(settings, /DEFAULT_HUMAN_SCORE_DEFINITIONS/u);
  assert.match(rating, /score === 2\.5 \|\| score === 3/u);
  assert.match(rating, /DEFAULT_PASSING_SCORES[^\n]*Object\.freeze\(\[2\.5, 3\]\)/u);
  assert.match(rating, /COPY_MACHINE_DRAFT_SCORE_PRESENTATION/u);
  assert.match(rating, /score: 1, title: '废弃'/u);
  assert.match(rating, /score: 2, title: '必须修改'/u);
  assert.match(rating, /score: 2\.5, title: '必须小修'/u);
  assert.match(rating, /score: 3, title: '可直接提交'/u);
  assert.match(rating, /passingScores: Object\.freeze<HumanScore\[\]>\(\[3\]\)/u);
  assert.match(rating, /2 分和 2\.5 分必须真实修改，人工确认修改达标后系统将最终稿记录为 3 分；只有原稿 3 分可直接提交审核结果/u);
  assert.match(rating, /后续按任务策略进入文案抽检或待生图队列/u);
  assert.doesNotMatch(rating, /可直接通过/u);
  assert.match(rating, /export function CopyMachineDraftScoreField/u);
  assert.match(rating, /passingScores\.includes\(option\.score\)/u);
  assert.match(rating, /passingScores\.includes\(score\)/u);
  assert.match(rating, /scoreDefinitions\.map/u);
  assert.match(rating, />人工评分</u);
  assert.match(rating, /human-rating-card-score/u);
  assert.match(rating, /human-rating-card-verdict/u);
  assert.match(rating, /human-rating-card-action/u);
  assert.match(rating, /showDescriptions && <strong className="human-rating-card-verdict">/u);
  assert.match(rating, /showDescriptions && <span className="human-rating-card-action">/u);
  assert.match(rating, /showReasonOptions && <fieldset/u);
  assert.match(rating, /feedbackRequired = true/u);
  assert.match(rating, /feedbackRequired \? '原因或说明至少填写一项' : '选填'/u);
  assert.match(rating, /showScoreDescriptions && scoreDefinition/u);
  assert.match(rating, /showReasonOptions && assessment\.reasonCodes\.length/u);
  assert.doesNotMatch(rating, /可放行 · 小修易达 3 分/u);
  assert.match(styles, /\.human-rating-options \{[^}]*grid-template-columns: repeat\(2,/u);
  assert.match(styles, /@container \(min-width: 760px\)[\s\S]*\.human-rating-options \{[^}]*grid-template-columns: repeat\(4,/u);
  assert.match(styles, /@container \(max-width: 300px\)[\s\S]*\.human-rating-options \{[^}]*grid-template-columns: minmax\(0, 1fr\)/u);
  assert.match(styles, /input:focus-visible \+ \.human-rating-card-body/u);
  assert.match(styles, /\.human-rating-reasons input\[type="checkbox"\]:checked \{[^}]*background-color: #218069/u);
  assert.doesNotMatch(styles, /\.human-rating-options input(?::checked|\[type="radio"\]:checked) \{/u);
  assert.match(qualitySummary, /当前图片自动质检/u);
});

test('locked copy fields explain score gates while plan fields use their own permission gate', async () => {
  const [source, styles, bubble] = await Promise.all([
    readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
    readFile(projectFile('components/ui/transient-info-bubble.tsx'), 'utf8'),
  ]);

  assert.match(source, /请先完成机器原稿评分；2 分或 2\.5 分可编辑文案内容/u);
  assert.match(source, /请先分配负责人，再进行文案评分和编辑/u);
  assert.match(source, /detail\.assignedToUserId === currentUsername/u);
  assert.match(source, /detail\.assignedToAccountId === currentAccountId/u);
  assert.match(source, /当前任务已分配给其他负责人，你可以查看，但不能评分或编辑/u);
  assert.doesNotMatch(source, /请先完成当前修改稿评分/u);
  assert.match(source, /当前稿评为 1 分，不支持编辑；只能评分并废弃任务/u);
  assert.match(source, /当前稿评为 3 分，已达到直接提交标准，无需修改/u);
  assert.doesNotMatch(source, /当前稿已评为 \$\{score\} 分；请先选择扣分原因/u);
  assert.match(source, /function getPlanEditBlockMessage/u);
  assert.match(source, /const message = area === 'plan' \? planEditBlockMessage : copyEditBlockMessage/u);
  assert.match(source, /data-edit-blocked=\{Boolean\(planEditBlockMessage\)\}/u);
  assert.match(source, /onClickCapture=\{\(\) => revealCopyEditNotice\('copy'\)\}/u);
  assert.match(source, /Date\.now\(\) - copyEditPointerAtRef\.current > 500/u);
  assert.match(source, /data-edit-reminder-exempt/u);
  assert.match(source, /TransientInfoBubble/u);
  assert.match(bubble, /role="status" aria-live="polite"/u);
  assert.match(bubble, /window\.setTimeout/u);
  assert.doesNotMatch(source, /copyEditDescriptionId/u);
  assert.match(styles, /\.transient-info-bubble \{[^}]*position: absolute/u);
  assert.match(styles, /@keyframes workbench-edit-tip-in/u);
  assert.match(styles, /\[data-edit-blocked="true"\][\s\S]*cursor: not-allowed/u);
});

test('copy review scores the machine draft once and auto-scores an edited approval at three', async () => {
  const source = await readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8');

  assert.match(source, /const copyFieldsEditable = editable && \(isCopyRework \|\| copyOriginalScore === 2 \|\| copyOriginalScore === 2\.5\)/u);
  assert.doesNotMatch(source, /copyFieldsEditable = editable && originalCopyRatingComplete/u);
  assert.match(source, /const planFieldsReadOnly = !\(editable \|\| canEditApprovedImagePlan\)/u);
  assert.match(source, /const planKindDisabled = !editable \|\| loading \|\| submitting/u);
  assert.match(source, /<CopyMachineDraftScoreField[\s\S]*legend=\{currentCopyRatingLabel\}/u);
  assert.match(source, /const currentCopyRatingLabel = '机器原稿初评（保留）'/u);
  assert.doesNotMatch(source, /copyScoreDefinition/u);
  assert.match(source, /copyOriginalScore === 2\.5[\s\S]*请完成必要的小修/u);
  assert.match(source, /COPY_MACHINE_DRAFT_SCORE_PRESENTATION\.passingScores/u);
  assert.match(source, /originalScorePresentation=\{COPY_MACHINE_DRAFT_SCORE_PRESENTATION\}/u);
  assert.doesNotMatch(source, /legend="修改后自评"|copyEditedScore|copyEditedReasons|copyEditedNote/u);
  const copyUpdate = source.slice(source.indexOf('function updateCopy('), source.indexOf('\n  }', source.indexOf('function updateCopy(')));
  assert.doesNotMatch(copyUpdate, /setCopyOriginal(?:Score|Reasons|Note)/u);
  const planUpdate = source.slice(source.indexOf('function updateImagePlan('), source.indexOf('\n  }', source.indexOf('function updateImagePlan(')));
  assert.doesNotMatch(planUpdate, /setCopyOriginal(?:Score|Reasons|Note)/u);
  assert.match(source, /const copyContentChanged = Boolean\(draft && savedDraft[\s\S]{0,100}JSON\.stringify\(draft\.copy\)/u);
  assert.match(source, /const copyContentChangedFromMachine = revision\?\.copyContentChangedFromMachine === true/u);
  assert.match(source, /const hasEditedCopyVersion = copyContentChanged \|\| copyContentChangedFromMachine/u);
  assert.match(source, /const canApproveCopy = isCopyRework \? copyReworkSatisfied/u);
  assert.match(source, /disabled=\{loading \|\| submitting \|\| humanQualitySettingsUnavailable \|\| Boolean\(savedCopyRatings\.current\) \|\| copyContentChanged\}/u);
  assert.match(source, /最终修改稿无需再次评分/u);
});

test('copy and image review visibility settings control their own guidance and reasons', async () => {
  const source = await readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8');

  assert.match(source, /humanRatingSettings\.copyReviewDisplay\.showScoreDescriptions/u);
  assert.match(source, /humanRatingSettings\.copyReviewDisplay\.showDeductionReasons/u);
  assert.match(source, /humanRatingSettings\.imageReviewDisplay\.showDeductionReasons/u);
  assert.match(source, /<CopyMachineDraftScoreField[\s\S]{0,240}showDescriptions=\{showCopyScoreDescriptions\}/u);
  assert.match(source, /showReasonOptions=\{showCopyDeductionReasons\}/u);
  assert.match(source, /showReasonOptions=\{showImageDeductionReasons\}/u);
  assert.match(source, /showScoreDescriptions=\{showCopyScoreDescriptions\} showReasonOptions=\{showCopyDeductionReasons\}/u);
  assert.match(source, /legend="整套图片评分"[\s\S]{0,180}scoreDefinitions=\{scoreDefinitions\}[\s\S]{0,180}disabled=/u);
  assert.match(source, /const canApproveImages = imageSetComplete && imageRatingComplete && isPassingHumanScore\(imageScore\)/u);
});

test('copy decisions use the shared payload builder and preserve the original assessment', async () => {
  const [source, builder] = await Promise.all([
    readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8'),
    readFile(projectFile('src/copy-review-submission.mjs'), 'utf8'),
  ]);

  assert.match(source, /decision: 'SAVE' \| 'APPROVE' \| 'DISCARD'/u);
  assert.match(source, /buildCopyReviewSubmission\(\{[\s\S]*copyContentChangedFromMachine,[\s\S]*originalScore: copyOriginalScore/u);
  assert.match(builder, /const approvingRework = decision === 'APPROVE' && copyRework === true/u);
  assert.match(builder, /const finalScore = approvingEditedRevision \|\| approvingRework \? 3 : originalScore/u);
  assert.match(builder, /includesRating \? \{[\s\S]*score: finalScore/u);
  assert.match(builder, /reasons: finalScore === 3 \? \[\] : cleanReasons\(originalReasons\)/u);
  assert.match(builder, /decision !== 'DISCARD' && draftChanged \? \{ edits: draft \} : \{\}/u);
  assert.match(builder, /originalScore,[\s\S]*originalReasons: cleanReasons\(originalReasons\),[\s\S]*originalNote:/u);
  assert.doesNotMatch(source, /revision\.executionId \? \{[\s\S]*originalScore/u);
  assert.match(source, /reviewSessionId: reviewSessionId\(requestPayload\)/u);
  assert.match(source, /submitCopyDecision\('SAVE'/u);
  assert.match(source, /submitCopyDecision\('DISCARD'/u);
  assert.match(source, /!canApproveCopy/u);
  assert.match(source, /decision === 'SAVE' && copyOriginalScore === 1/u);
  assert.match(source, /保存评分，暂不提交/u);
  assert.match(source, /评分并废弃/u);
});

test('image review requires only a whole-set score while keeping feedback optional', async () => {
  const source = await readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8');

  assert.match(source, /legend="整套图片评分"/u);
  assert.match(source, /const imageRatingComplete = imageScore !== null/u);
  assert.doesNotMatch(source, /ratingFeedbackComplete\(imageScore, imageReasons, imageReviewNote\)/u);
  assert.match(source, /feedbackRequired=\{false\}/u);
  assert.doesNotMatch(source, /评分低于 3 分时，扣分原因或评分说明至少填写一项/u);
  assert.match(source, /problemAssetIds: imageScore === 3 \? \[\] : imageProblemAssetIds/u);
  assert.match(source, /reasons: imageScore === 3 \? \[\] : imageReasons/u);
  assert.match(source, /note: imageScore === 3 \? '' : imageReviewNote\.trim\(\)/u);
  assert.match(source, /const canApproveImages = imageSetComplete && imageRatingComplete && isPassingHumanScore\(imageScore\)/u);
  assert.match(source, /disabled=\{submitting \|\| loading \|\| !imageRatingComplete\}/u);
  assert.match(source, /disabled=\{submitting \|\| loading \|\| !canApproveImages\}/u);
});
