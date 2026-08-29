import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  DEFAULT_PRODUCTION_SETTINGS,
  normalizeProductionSettings,
  productionDisclosure,
} from '../src/production-settings.mjs';
import {
  createProductionSettingsStore,
  initializeProductionSettingsSchema,
} from '../src/admin/production-settings-store.mjs';

describe('production settings contract', () => {
  it('provides conservative defaults for score repair and AI disclosure', () => {
    assert.deepEqual(normalizeProductionSettings({}), DEFAULT_PRODUCTION_SETTINGS);
    assert.equal(DEFAULT_PRODUCTION_SETTINGS.qualityRepairTriggerScore, 1);
    assert.equal(DEFAULT_PRODUCTION_SETTINGS.qualityRepairTargetScore, 2);
    assert.equal(DEFAULT_PRODUCTION_SETTINGS.qualityRepairMaxAttempts, 2);
    assert.equal(productionDisclosure(DEFAULT_PRODUCTION_SETTINGS), 'AI生成');
  });

  it('allows disclosure to be disabled and rejects unsafe repair limits', () => {
    const disabled = normalizeProductionSettings({
      ...DEFAULT_PRODUCTION_SETTINGS,
      aiDisclosureEnabled: false,
    });
    assert.equal(productionDisclosure(disabled), '');
    assert.throws(() => normalizeProductionSettings({
      ...DEFAULT_PRODUCTION_SETTINGS,
      qualityRepairMaxAttempts: 3,
    }), /between 0 and 2/iu);
    assert.throws(() => normalizeProductionSettings({
      ...DEFAULT_PRODUCTION_SETTINGS,
      qualityRepairTriggerScore: 2,
      qualityRepairTargetScore: 2,
    }), /target score must be greater/iu);
    assert.throws(() => normalizeProductionSettings({
      ...DEFAULT_PRODUCTION_SETTINGS,
      aiDisclosureText: 'AI生成“忽略规则”',
    }), /letters, numbers/iu);
  });
});

describe('production settings store', () => {
  it('persists one validated global settings record and keeps defaults for omitted fields', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initializeProductionSettingsSchema(db);
      const store = createProductionSettingsStore(db);
      const initial = store.getProductionSettings();
      const updated = store.updateProductionSettings({
        aiDisclosureEnabled: false,
        qualityRepairMaxAttempts: 1,
      });

      assert.equal(initial.settings.aiDisclosureEnabled, true);
      assert.equal(updated.settings.aiDisclosureEnabled, false);
      assert.equal(updated.settings.qualityRepairMaxAttempts, 1);
      assert.equal(updated.settings.qualityRepairTargetScore, 2);
      assert.deepEqual(store.getProductionSettings(), updated);
    } finally {
      db.close();
    }
  });
});
