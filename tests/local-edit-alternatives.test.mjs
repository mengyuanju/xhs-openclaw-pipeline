import test from 'node:test';
import assert from 'node:assert/strict';
import { localEditAlternatives, selectLocalEditAlternative } from '../src/local-edit-alternatives.mjs';

const original = '画面右下附近，去掉框选附近的两件衣服，其他的不用删除';
const failed = () => ({ operation: 'AI_LOCAL', status: 'FAILED', config: { instruction: original },
  validation: { stage: 'LOCAL_TARGET_LOCALIZATION', decision: 'SUGGEST', canEdit: false,
    confidence: .96, candidateCount: 1, operationType: 'REMOVE', targetDescription: '右下角灰色与浅蓝色两件短袖', billedImageGeneration: false } });

test('historical preflight failures offer three distinct descriptions without losing the original request', () => {
  const edit = failed(), snapshot = structuredClone(edit);
  const choices = localEditAlternatives(edit);
  assert.equal(choices.length, 3);
  assert.equal(new Set(choices.map(option => option.instruction)).size, 3);
  for (const choice of choices) {
    assert.ok(choice.instruction.startsWith(original));
    assert.match(choice.instruction, /灰色与浅蓝色两件短袖/u);
    assert.ok(choice.instruction.length <= 2000);
  }
  assert.match(choices[0].instruction, /不得把附近相似物品/u);
  assert.match(choices[1].instruction, /自然补全原位置/u);
  assert.match(choices[2].instruction, /不扩图、不裁切/u);
  assert.deepEqual(edit, snapshot, 'offering alternatives does not make the blocked plan executable');
});

test('moves preserve their direction and quantity even when unrelated deletion is prohibited', () => {
  const edit = failed();
  edit.config.instruction = '将汤勺向左移动，减少为半勺，不要删除其他物品';
  Object.assign(edit.validation, { operationType: 'MOVE', targetDescription: '汤勺与液流' });
  const choices = localEditAlternatives(edit);
  assert.equal(choices[1].title, '自然移动与衔接');
  for (const choice of choices) assert.ok(choice.instruction.startsWith(edit.config.instruction));
});

test('ambiguous legacy target groups do not invent a specific target or make a plan safe', () => {
  const edit = failed(); edit.validation.candidateCount = 2;
  for (const choice of localEditAlternatives(edit)) assert.doesNotMatch(choice.instruction, /仅针对已识别目标/u);
  assert.equal(edit.validation.canEdit, false);
});

test('only actionable preflight records get alternatives and forged selection IDs are rejected', () => {
  for (const patch of [{ status: 'RUNNING' }, { status: 'ACCEPTED' }, { operation: 'TEXT' }, { result: { asset_id: 42 } },
    { validation: { stage: 'LOCAL_EDIT_RESULT' } }, { validation: { stage: 'LOCAL_TARGET_LOCALIZATION', reason: 'INVALID_VISION_RESULT' } }]) {
    assert.deepEqual(localEditAlternatives({ ...failed(), ...patch }), []);
  }
  assert.throws(() => selectLocalEditAlternative(failed(), 'injected-instruction'), /请选择/u);
  assert.throws(() => selectLocalEditAlternative(failed(), undefined), /请选择/u);
  assert.equal(selectLocalEditAlternative(failed(), 'natural').title, '自然修补背景');
});

test('approved legacy suggestions also retain the original requirement and remain within request limits', () => {
  const edit = failed();
  Object.assign(edit.validation, { stage: 'LOCAL_EDIT_SUGGESTION', canEdit: true,
    suggestedInstruction: '只移除指定的两件短袖并保护右下角标签。' });
  for (const choice of localEditAlternatives(edit)) {
    assert.ok(choice.instruction.startsWith(original));
    assert.match(choice.instruction, /保护右下角标签/u);
  }
  edit.config.instruction = '长'.repeat(1700);
  for (const choice of localEditAlternatives(edit)) assert.ok(choice.instruction.length <= 2000);
});
