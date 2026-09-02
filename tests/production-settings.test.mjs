import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  DEFAULT_PRODUCTION_SETTINGS,
  normalizeProductionSettings,
  productionDisclosure,
} from '../src/production-settings.mjs';
import { effectiveModelApiConfig } from '../src/model-api-config.mjs';
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

  it('keeps model API overrides in production settings and falls back predictably', () => {
    const settings = normalizeProductionSettings({
      modelApi: {
        copyGenerationProvider: 'DOTS',
        dotsBaseUrl: 'https://note3-prev-api.askdiandian.com',
        dotsModel: 'dots3-note-prev',
        textModel: 'openai/gpt-5.6-terra',
        qualityModel: 'openai/gpt-5.6-sol',
        modelProxyUrl: 'http://127.0.0.1:7897',
        imageTimeoutMs: 420_000,
      },
    });
    const effective = effectiveModelApiConfig(settings.modelApi, {
      XHS_REVIEW_MODEL: 'openai/gpt-5.4',
      XHS_IMAGE_MODEL: 'openai/gpt-image-2',
      XHS_IMAGE_PROXY_URL: 'http://127.0.0.1:7898',
    });

    assert.equal(settings.modelApi.textModel, 'openai/gpt-5.6-terra');
    assert.equal(effective.copyGenerationProvider, 'DOTS');
    assert.equal(effective.copyGenerationThinking, 'low');
    assert.equal(effective.dotsBaseUrl, 'https://note3-prev-api.askdiandian.com');
    assert.equal(effective.dotsModel, 'dots3-note-prev');
    assert.equal(settings.modelApi.reviewModel, null);
    assert.equal(effective.textModel, 'openai/gpt-5.6-terra');
    assert.equal(effective.reviewModel, 'openai/gpt-5.4');
    assert.equal(effective.screeningModel, 'openai/gpt-5.6-terra');
    assert.equal(effective.visionModel, 'openai/gpt-5.6-terra');
    assert.equal(effective.qualityModel, 'openai/gpt-5.6-sol');
    assert.equal(effective.imageModel, 'openai/gpt-image-2');
    assert.equal(effective.modelProxyUrl, 'http://127.0.0.1:7897');
    assert.equal(effective.imageProxyUrl, 'http://127.0.0.1:7898');
    assert.equal(effective.imageTimeoutMs, 420_000);
  });

  it('stores copy generation thinking and resolves setting, environment and default precedence', () => {
    const configured = normalizeProductionSettings({
      modelApi: { copyGenerationThinking: 'max' },
    });

    assert.equal(configured.modelApi.copyGenerationThinking, 'max');
    assert.equal(effectiveModelApiConfig(configured.modelApi, {
      XHS_COPY_GENERATION_THINKING: 'medium',
    }).copyGenerationThinking, 'max');
    assert.equal(effectiveModelApiConfig({}, {
      XHS_COPY_GENERATION_THINKING: 'xhigh',
    }).copyGenerationThinking, 'xhigh');
    assert.equal(effectiveModelApiConfig({}, {}).copyGenerationThinking, 'low');
  });

  it('rejects unsafe model references, credential-bearing proxies and timeouts', () => {
    assert.throws(() => normalizeProductionSettings({
      modelApi: { textModel: 'gpt without provider' },
    }), /provider\/model/iu);
    assert.throws(() => normalizeProductionSettings({
      modelApi: { modelProxyUrl: 'http://user:secret@127.0.0.1:7897' },
    }), /credentials/iu);
    assert.throws(() => normalizeProductionSettings({
      modelApi: { imageTimeoutMs: 10_000 },
    }), /between 30000 and 540000/iu);
    assert.throws(() => normalizeProductionSettings({
      modelApi: { copyGenerationProvider: 'UNTRUSTED' },
    }), /OPENCLAW or DOTS/iu);
    assert.throws(() => normalizeProductionSettings({
      modelApi: { dotsBaseUrl: 'http://127.0.0.1:3000' },
    }), /documented Dots API origin/iu);
    assert.throws(() => normalizeProductionSettings({
      modelApi: { copyGenerationThinking: 'unlimited' },
    }), /thinking/iu);
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

  it('deep-merges partial model API patches without clearing other overrides', () => {
    const db = new DatabaseSync(':memory:');
    try {
      initializeProductionSettingsSchema(db);
      const store = createProductionSettingsStore(db);
      store.updateProductionSettings({
        modelApi: {
          textModel: 'openai/gpt-5.6-terra',
          imageModel: 'openai/gpt-image-2',
          copyGenerationThinking: 'high',
        },
      });
      const updated = store.updateProductionSettings({
        modelApi: { reviewModel: 'openai/gpt-5.4' },
      });

      assert.equal(updated.settings.modelApi.textModel, 'openai/gpt-5.6-terra');
      assert.equal(updated.settings.modelApi.reviewModel, 'openai/gpt-5.4');
      assert.equal(updated.settings.modelApi.imageModel, 'openai/gpt-image-2');
      assert.equal(updated.settings.modelApi.copyGenerationThinking, 'high');
      assert.equal(updated.settings.modelApi.imageProxyUrl, null);
    } finally {
      db.close();
    }
  });
});
