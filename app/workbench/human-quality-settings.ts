'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiRequest } from '../components/api-client';
import { DEFAULT_HUMAN_QUALITY_SETTINGS } from '../../src/human-quality-settings.mjs';

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
export type HumanQualitySettings = {
  scoreDefinitions: HumanScoreDefinition[];
  copyReasons: HumanQualityReasonOption[];
  imageReasons: HumanQualityReasonOption[];
  noteGuidance: HumanQualityNoteGuidance;
  copyReviewDisplay: CopyReviewDisplay;
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
};

export async function loadHumanQualitySettings() {
  return apiRequest<HumanQualitySettings>('/api/human-quality-settings');
}

export function useHumanQualitySettings(refreshKey?: string | number | null) {
  const [settings, setSettings] = useState<HumanQualitySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    setSettings(null);
    try {
      const value = await loadHumanQualitySettings();
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
  }, []);

  useEffect(() => {
    void refresh();
    return () => { requestRef.current += 1; };
  }, [refresh, refreshKey]);

  return { settings, loading, error, refresh };
}
