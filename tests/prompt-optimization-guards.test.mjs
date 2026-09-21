import assert from 'node:assert/strict';
import test from 'node:test';

import {
  missingPromptOptimizationGuards,
  promptOptimizationGuardStatuses,
} from '../src/prompt-optimization-guards.mjs';
import { defaultBusinessPrompt } from '../src/prompt-runtime.mjs';

test('the bundled text prompt retains the protected content and visual responsibility rule', () => {
  const statuses = promptOptimizationGuardStatuses('TEXT_SYSTEM', defaultBusinessPrompt('TEXT_SYSTEM'));
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].present, true);
  assert.match(statuses[0].rule, /根据内容类型/u);
  assert.match(statuses[0].rule, /imagePlan/u);
  assert.deepEqual(missingPromptOptimizationGuards('TEXT_SYSTEM', defaultBusinessPrompt('TEXT_SYSTEM')), []);
});

test('guard detection survives rule wording edits but detects deleted markers or empty content', () => {
  const changed = '【关键优化开始：正文与配图职责分离-V1】\n新的有效规则\n【关键优化结束：正文与配图职责分离-V1】';
  assert.equal(promptOptimizationGuardStatuses('TEXT_SYSTEM', changed)[0].present, true);
  assert.equal(promptOptimizationGuardStatuses('TEXT_SYSTEM', changed)[0].rule, '新的有效规则');

  for (const content of [
    '新的有效规则\n【关键优化结束：正文与配图职责分离-V1】',
    '【关键优化开始：正文与配图职责分离-V1】\n\n【关键优化结束：正文与配图职责分离-V1】',
  ]) assert.equal(missingPromptOptimizationGuards('TEXT_SYSTEM', content).length, 1);
});
