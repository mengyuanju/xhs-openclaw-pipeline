'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiRequest } from '../components/api-client';
import type {
  CopyGenerationResult,
  CopyGenerationTimingStatistics,
} from './copy-generation-comparison';

const HISTORY_URL = '/api/copy-generations?page=1&pageSize=20';
const RUNNING_JOB_POLL_MS = 2_500;

export type CopyGenerationStage =
  | 'QUERY_REVIEW'
  | 'RESEARCH'
  | 'ORIGINAL_GENERATION'
  | 'ORIGINAL_REVIEW'
  | 'REVIEWED_GENERATION'
  | 'REVIEWED_REVIEW';

export type CopyGenerationJob = {
  id: number;
  query: string;
  status: 'RUNNING' | 'FAILED';
  generationId: null;
  currentStage: CopyGenerationStage;
  stageUpdatedAt: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

type CopyGenerationHistoryResponse = {
  data: CopyGenerationResult[];
  jobs: CopyGenerationJob[];
  statistics: CopyGenerationTimingStatistics;
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
};

export function useCopyGenerationHistory({ pollWhileRequestBusy = false } = {}) {
  const [result, setResult] = useState<CopyGenerationResult | null>(null);
  const [history, setHistory] = useState<CopyGenerationResult[]>([]);
  const [jobs, setJobs] = useState<CopyGenerationJob[]>([]);
  const [timingStatistics, setTimingStatistics] = useState<CopyGenerationTimingStatistics | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');

  const refreshHistory = useCallback(async ({ silent = false } = {}) => {
    try {
      const response = await apiRequest<CopyGenerationHistoryResponse>(HISTORY_URL);
      setHistory(response.data);
      setJobs(response.jobs);
      setTimingStatistics(response.statistics);
      setHistoryError('');
      setResult((current) => current ?? response.data[0] ?? null);
      return response;
    } catch (error) {
      if (!silent) {
        setHistoryError(error instanceof Error ? error.message : '历史记录读取失败');
      }
      throw error;
    } finally {
      if (!silent) setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshHistory().catch(() => {});
  }, [refreshHistory]);

  const hasRunningJobs = jobs.some((job) => job.status === 'RUNNING');

  useEffect(() => {
    if (!hasRunningJobs && !pollWhileRequestBusy) return undefined;
    void refreshHistory({ silent: true }).catch(() => {});
    const intervalId = window.setInterval(() => {
      void refreshHistory({ silent: true }).catch(() => {});
    }, RUNNING_JOB_POLL_MS);
    return () => window.clearInterval(intervalId);
  }, [hasRunningJobs, pollWhileRequestBusy, refreshHistory]);

  return {
    result,
    setResult,
    history,
    jobs,
    timingStatistics,
    historyLoading,
    historyError,
    hasRunningJobs,
    refreshHistory,
  };
}
