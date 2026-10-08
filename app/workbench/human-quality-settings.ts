'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiRequest } from '../components/api-client';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../../src/human-quality-settings.mjs';
import { browserSessionGeneration } from '../components/session-client';
import { createSessionReadCache } from '../components/session-read-cache';
import { notifyWorkspaceUpdated, subscribeWorkspaceUpdates, workspaceUpdateRevision } from '../components/workspace-updates';

export type HumanQualityReasonOption = { code: string; label: string };
export type HumanScore = 1 | 2 | 2.5 | 3;
export type HumanScoreDefinition = {
  score: HumanScore;
  title: string;
  description: string;
};
export type HumanQualityNoteGuidance = {
  copyPlaceholder: string;
  imagePlaceholder: string;
};
export type CopyReviewDisplay = {
  showScoreDescriptions: boolean;
  showDeductionReasons: boolean;
};
export type ImageReviewDisplay = {
  showDeductionReasons: boolean;
};
export type HumanQualitySettings = {
  scoreDefinitions: HumanScoreDefinition[];
  copyReasons: HumanQualityReasonOption[];
  imageReasons: HumanQualityReasonOption[];
  noteGuidance: HumanQualityNoteGuidance;
  copyReviewDisplay: CopyReviewDisplay;
  imageReviewDisplay: ImageReviewDisplay;
};

export const DEFAULT_SETTINGS: HumanQualitySettings = {
  scoreDefinitions: DEFAULT_HUMAN_QUALITY_SETTINGS.scoreDefinitions.map((definition) => ({
    ...definition,
    score: definition.score as HumanScore,
  })),
  copyReasons: DEFAULT_HUMAN_QUALITY_SETTINGS.copyReasons.map((reason) => ({ ...reason })),
  imageReasons: DEFAULT_HUMAN_QUALITY_SETTINGS.imageReasons.map((reason) => ({ ...reason })),
  noteGuidance: { ...DEFAULT_HUMAN_QUALITY_SETTINGS.noteGuidance },
  copyReviewDisplay: { ...DEFAULT_HUMAN_QUALITY_SETTINGS.copyReviewDisplay },
  imageReviewDisplay: { ...DEFAULT_HUMAN_QUALITY_SETTINGS.imageReviewDisplay },
};

const settingsCache = createSessionReadCache<HumanQualitySettings>({
  scope: browserSessionGeneration, ttlMs: 60_000,
  read: signal => apiRequest('/api/human-quality-settings', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), cache: 'no-store',
  }),
});
let invalidatedRevision = -1;

export function loadHumanQualitySettings() { return settingsCache.load(); }

export function invalidateHumanQualitySettings() {
  settingsCache.invalidate();
  notifyWorkspaceUpdated({ scopes: ['settings'] });
}

export function useHumanQualitySettings(refreshKey?: string | number | null, enabled = true) {
  const [settings, setSettings] = useState<HumanQualitySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const read = useCallback(async (fresh = false) => {
    if (!enabled) return null;
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    setSettings(null);
    try {
      const value = await settingsCache.load({ fresh });
      if (requestId === requestRef.current) setSettings(value);
      return value;
    } catch (caught) {
      if (requestId === requestRef.current) {
        setError(caught instanceof Error ? caught.message : '扣分原因读取失败');
      }
      return null;
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [enabled]);
  const refresh = useCallback(() => read(true), [read]);

  useEffect(() => {
    if (!enabled) { setSettings(null); setLoading(false); setError(null); return; }
    void read();
    const unsubscribe = subscribeWorkspaceUpdates(() => {
      const revision = workspaceUpdateRevision();
      if (revision !== invalidatedRevision) { invalidatedRevision = revision; settingsCache.invalidate(); }
      void read();
    }, { scopes: ['settings'] });
    return () => { requestRef.current += 1; unsubscribe(); };
  }, [read, refreshKey, enabled]);

  return { settings, loading, error, refresh };
}
