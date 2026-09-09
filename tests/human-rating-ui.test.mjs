import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test('human rating control exposes four levels and only scores above two pass', async () => {
  const [rating, qualitySummary, styles] = await Promise.all([
    readFile(projectFile('app/workbench/human-quality-rating.tsx'), 'utf8'),
    readFile(projectFile('app/workbench/task-quality-summary.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  for (const score of ['1', '2', '2.5', '3']) {
    assert.match(rating, new RegExp(`score: ${score.replace('.', '\\.')},`, 'u'));
  }
  assert.match(rating, /score === 2\.5 \|\| score === 3/u);
  assert.match(rating, />人工评分</u);
  assert.match(rating, /human-rating-card-score/u);
  assert.match(rating, /human-rating-card-verdict/u);
  assert.match(rating, /human-rating-card-action/u);
  assert.match(rating, /可放行 · 小修易达 3 分/u);
  assert.match(styles, /\.human-rating-options \{[^}]*grid-template-columns: repeat\(2,/u);
  assert.match(styles, /@container \(min-width: 760px\)[\s\S]*\.human-rating-options \{[^}]*grid-template-columns: repeat\(4,/u);
  assert.match(styles, /@container \(max-width: 300px\)[\s\S]*\.human-rating-options \{[^}]*grid-template-columns: minmax\(0, 1fr\)/u);
  assert.match(styles, /input:focus-visible \+ \.human-rating-card-body/u);
  assert.match(styles, /\.human-rating-reasons input\[type="checkbox"\]:checked \{[^}]*background-color: #218069/u);
  assert.doesNotMatch(styles, /\.human-rating-options input(?::checked|\[type="radio"\]:checked) \{/u);
  assert.match(qualitySummary, /当前图片自动质检/u);
});

test('locked copy fields explain every rating prerequisite on pointer and keyboard focus', async () => {
  const [source, styles, bubble] = await Promise.all([
    readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
    readFile(projectFile('components/ui/transient-info-bubble.tsx'), 'utf8'),
  ]);

  assert.match(source, /请先完成机器原稿评分并填写反馈后再编辑/u);
  assert.match(source, /请先分配负责人，再进行文案评分和编辑/u);
  assert.match(source, /detail\.assignedToUserId === currentUsername/u);
  assert.match(source, /detail\.assignedToAccountId === currentAccountId/u);
  assert.match(source, /当前任务已分配给其他负责人，你可以查看，但不能评分或编辑/u);
  assert.match(source, /请先完成当前修改稿评分并填写反馈后再编辑/u);
  assert.match(source, /当前稿评为 1 分，不支持编辑/u);
  assert.match(source, /当前稿评为 3 分，已达到直接放行标准，无需修改/u);
  assert.match(source, /当前稿已评为 \$\{score\} 分；请先选择扣分原因或填写评分说明后再编辑/u);
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

test('copy review rates the current version before editing and resets edited feedback after every change', async () => {
  const source = await readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8');

  assert.match(source, /const copyFieldsEditable = editable && originalCopyRatingComplete[\s\S]{0,80}\(copyOriginalScore === 2 \|\| copyOriginalScore === 2\.5\)/u);
  assert.match(source, /legend=\{currentCopyRatingLabel\}/u);
  assert.match(source, /legend="修改后自评"/u);
  for (const functionName of ['updateCopy', 'updateImagePlan']) {
    const start = source.indexOf(`function ${functionName}`);
    const end = source.indexOf('\n  }', start);
    const body = source.slice(start, end);
    assert.match(body, /setCopyEditedScore\(null\)/u);
    assert.match(body, /setCopyEditedReasons\(\[\]\)/u);
    assert.match(body, /setCopyEditedNote\(''\)/u);
  }
  assert.match(source, /copyMaterialChanged \? copyEditedScore : copyOriginalScore/u);
  assert.match(source, /ratingFeedbackComplete\(effectiveCopyScore, effectiveCopyReasons, effectiveCopyNote\)/u);
});

test('copy decisions persist current rating and preserve machine-original rating only across first edits', async () => {
  const source = await readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8');

  assert.match(source, /decision: 'SAVE' \| 'APPROVE' \| 'DISCARD'/u);
  assert.match(source, /score: effectiveCopyScore/u);
  assert.match(source, /reasons: effectiveCopyScore === 3 \? \[\] : effectiveCopyReasons/u);
  assert.match(source, /draftChanged[\s\S]*revision\.executionId[\s\S]*originalScore: copyOriginalScore/u);
  assert.match(source, /reviewSessionId: reviewSessionId\(requestPayload\)/u);
  assert.match(source, /submitCopyDecision\('SAVE'/u);
  assert.match(source, /submitCopyDecision\('DISCARD'/u);
  assert.match(source, /!canApproveCopy/u);
  assert.match(source, /保存评分，暂不放行/u);
  assert.match(source, /评分并废弃/u);
});

test('image review records whole-set score, reasons, note and problem pages before any decision', async () => {
  const source = await readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8');

  assert.match(source, /legend="整套图片评分"/u);
  assert.match(source, /ratingFeedbackComplete\(imageScore, imageReasons, imageReviewNote\)/u);
  assert.match(source, /problemAssetIds: imageScore === 3 \? \[\] : imageProblemAssetIds/u);
  assert.match(source, /reasons: imageScore === 3 \? \[\] : imageReasons/u);
  assert.match(source, /note: imageScore === 3 \? '' : imageReviewNote\.trim\(\)/u);
  assert.match(source, /const canApproveImages = imageSetComplete && imageRatingComplete && isPassingHumanScore\(imageScore\)/u);
  assert.match(source, /disabled=\{submitting \|\| loading \|\| !imageRatingComplete\}/u);
  assert.match(source, /disabled=\{submitting \|\| loading \|\| !canApproveImages\}/u);
});
