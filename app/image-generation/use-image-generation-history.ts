'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiRequest } from '../components/api-client';

const HISTORY_URL = '/api/image-generations?limit=50';
const RUNNING_HISTORY_POLL_MS = 30_000;

export type ImageGenerationHistoryRecord = {
  runId: string;
  query: string;
  title: string;
  mode: 'LIVE';
  status: 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
  stage: string;
  completedImages: number;
  generatedImages: number;
  validatedImages: number;
  canResume: boolean;
  retryReason: string | null;
  imageCount: number;
  qcScore: number | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  error: string | null;
};

type ImageGenerationHistoryResponse = {
  data: ImageGenerationHistoryRecord[];
  total: number;
};

export function useImageGenerationHistory({ pollWhile = false }: { pollWhile?: boolean } = {}) {
  const [records, setRecords] = useState<ImageGenerationHistoryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refreshHistory = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const response = await apiRequest<ImageGenerationHistoryResponse>(HISTORY_URL, {
        cache: 'no-store',
      });
      setRecords(response.data);
      setTotal(response.total);
      setError('');
      return response;
    } catch (historyError) {
      if (!silent) {
        setError(historyError instanceof Error ? historyError.message : '图片历史记录读取失败');
      }
      throw historyError;
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshHistory().catch(() => {});
  }, [refreshHistory]);

  const hasRunningRuns = records.some((record) => record.status === 'RUNNING');

  useEffect(() => {
    if (!hasRunningRuns && !pollWhile) return undefined;
    void refreshHistory({ silent: true }).catch(() => {});
    const intervalId = window.setInterval(() => {
      void refreshHistory({ silent: true }).catch(() => {});
    }, RUNNING_HISTORY_POLL_MS);
    return () => window.clearInterval(intervalId);
  }, [hasRunningRuns, pollWhile, refreshHistory]);

  return {
    records,
    total,
    loading,
    error,
    hasRunningRuns,
    refreshHistory,
  };
}
