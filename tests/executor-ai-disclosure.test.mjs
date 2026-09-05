import assert from 'node:assert/strict';
import test from 'node:test';

import { productionSettings } from '../src/executor/agent.mjs';
import { productionDisclosure } from '../src/production-settings.mjs';

test('image execution uses the task AI disclosure choice over the global setting', () => {
  const globalSettings = {
    aiDisclosureEnabled: true,
    aiDisclosureText: 'AI生成',
    qualityRepairEnabled: true,
  };
  const disabled = productionSettings({
    task: { aiDisclosureEnabled: false },
    productionSettings: { production: { value: globalSettings } },
  });
  const enabled = productionSettings({
    task: { aiDisclosureEnabled: true },
    productionSettings: { production: { value: { ...globalSettings, aiDisclosureEnabled: false } } },
  });

  assert.equal(disabled.aiDisclosureEnabled, false);
  assert.equal(enabled.aiDisclosureEnabled, true);
  assert.equal(productionDisclosure(disabled), '');
  assert.equal(productionDisclosure(enabled), 'AI生成');
  assert.equal(disabled.aiDisclosureText, 'AI生成');
  assert.equal(globalSettings.aiDisclosureEnabled, true, 'snapshot settings stay immutable');
});

test('older snapshots without a task choice preserve the global AI disclosure setting', () => {
  const settings = { aiDisclosureEnabled: false, aiDisclosureText: 'AI生成' };
  assert.equal(productionSettings({
    task: {},
    productionSettings: { production: { value: settings } },
  }), settings);
});
