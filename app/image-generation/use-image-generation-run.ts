'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiRequest } from '../components/api-client';

const ACTIVE_RUN_STORAGE_KEY = 'xhs:image-generation-active-run:v1';
const PROGRESS_POLL_MS = 1_000;
const PROGRESS_MISS_LIMIT = 10;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ImageGenerationResult = {
  runId: string;
  mode: 'MOCK' | 'LIVE';
  status: 'COMPLETED' | 'BLOCKED';
  imageCount: number;
  images: Array<{
    pageIndex: number;
    kind: string;
    url: string;
    provider: string;
    model: string | null;
    generationAttempts: number | null;
    alignmentPassed: boolean | null;
    layout: {
      layoutTemplate: string;
      layoutDirection: string;
      visualSubject: string;
      allowedVisibleText: {
        headline: string;
        subtitle: string;
        bullets: string[];
        labels: string[];
      };
      mustShow: string[];
      mustAvoid: string[];
    } | null;
  }>;
  visualPlan: {
    model: string | null;
    degraded: boolean;
    warning: {
      stage: string;
      code: string;
      message: string;
    } | null;
  } | null;
  qc: {
    passed: boolean;
    overallScore: number | null;
    summary: string;
    disposition: string;
    action: string | null;
    issues: Array<{
      severity: string;
      label: string;
      evidence: string;
    }>;
    dimensions: Array<{
      key: string;
      score: number | null;
      applicable: boolean;
      evidence: string[];
    }>;
    limitations: string[];
  };
};

export type ImageGenerationProgressValue = {
  runId: string;
  mode: 'MOCK' | 'LIVE';
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  stage: 'PREPARING' | 'PLANNING' | 'GENERATING' | 'ALIGNING' | 'QUALITY_CHECK' | 'FINALIZING' | 'COMPLETED' | 'FAILED';
  progressPercent: number;
  message: string;
  completedImages: number;
  totalImages: number;
  currentPage: number | null;
  attempt: number | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  estimatedTotalMs: number;
  elapsedMs: number;
  estimatedRemainingMs: number | null;
  estimateBasis: 'mode-and-page-count';
  estimateOverdue: boolean;
  error: string | null;
  result: ImageGenerationResult | null;
};

export type ImageGenerationRequest = {
  query: string;
  copy: { title: string; body: string; tags: string[] };
  imagePlan: unknown[];
  mode: 'MOCK' | 'LIVE';
  confirmation?: 'LIVE_IMAGE_COST_ACCEPTED';
};

function completionMessage(mode: 'MOCK' | 'LIVE') {
  return mode === 'MOCK'
    ? 'Mock 图片链路验证完成；占位图不能用于发布。'
    : '真实图片生成与质量检查完成，请继续人工抽查。';
}

export function useImageGenerationRun() {
  const [runId, setRunId] = useState<string | null>(null);
  const [openingRunId, setOpeningRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImageGenerationProgressValue | null>(null);
  const [result, setResult] = useState<ImageGenerationResult | null>(null);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const activeRunId = useRef<string | null>(null);
  const progressMisses = useRef(0);

  function showMessage(nextMessage: string, isError: boolean) {
    setMessage(nextMessage);
    setMessageIsError(isError);
  }

  const refreshProgress = useCallback(async (targetRunId: string) => {
    const next = await apiRequest<ImageGenerationProgressValue>(
      `/api/image-generations/${targetRunId}`,
      { cache: 'no-store' },
    );
    if (activeRunId.current !== targetRunId) return next;
    progressMisses.current = 0;
    setProgress(next);
    if (next.result) setResult(next.result);
    if (next.status === 'COMPLETED') {
      setBusy(false);
      setMessage(completionMessage(next.mode));
      setMessageIsError(false);
    } else if (next.status === 'FAILED') {
      setBusy(false);
      setMessage(next.error || '图片生成失败');
      setMessageIsError(true);
    }
    return next;
  }, []);

  const forgetRun = useCallback(() => {
    window.sessionStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
    activeRunId.current = null;
    progressMisses.current = 0;
    setRunId(null);
    setBusy(false);
  }, []);

  useEffect(() => {
    const storedRunId = window.sessionStorage.getItem(ACTIVE_RUN_STORAGE_KEY);
    if (!storedRunId) return;
    if (!RUN_ID.test(storedRunId)) {
      window.sessionStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
      return;
    }
    activeRunId.current = storedRunId;
    setRunId(storedRunId);
    setBusy(true);
    void refreshProgress(storedRunId).catch(() => {
      progressMisses.current = 1;
    });
  }, [refreshProgress]);

  useEffect(() => {
    if (!runId || !busy) return undefined;
    const intervalId = window.setInterval(() => {
      void refreshProgress(runId).catch(() => {
        progressMisses.current += 1;
        if (progressMisses.current >= PROGRESS_MISS_LIMIT) forgetRun();
      });
    }, PROGRESS_POLL_MS);
    return () => window.clearInterval(intervalId);
  }, [busy, forgetRun, refreshProgress, runId]);

  const openRun = useCallback(async (targetRunId: string) => {
    if (!RUN_ID.test(targetRunId)) {
      setMessage('图片历史记录 ID 无效');
      setMessageIsError(true);
      return null;
    }
    setOpeningRunId(targetRunId);
    setProgress(null);
    setResult(null);
    setMessage('');
    setMessageIsError(false);
    activeRunId.current = targetRunId;
    setRunId(targetRunId);
    window.sessionStorage.setItem(ACTIVE_RUN_STORAGE_KEY, targetRunId);
    try {
      const next = await refreshProgress(targetRunId);
      if (activeRunId.current === targetRunId) setBusy(next.status === 'RUNNING');
      return next;
    } catch (error) {
      forgetRun();
      setMessage(error instanceof Error ? error.message : '图片历史记录读取失败');
      setMessageIsError(true);
      return null;
    } finally {
      setOpeningRunId(null);
    }
  }, [forgetRun, refreshProgress]);

  async function startRun(request: ImageGenerationRequest) {
    const nextRunId = crypto.randomUUID();
    activeRunId.current = nextRunId;
    progressMisses.current = 0;
    window.sessionStorage.setItem(ACTIVE_RUN_STORAGE_KEY, nextRunId);
    setRunId(nextRunId);
    setBusy(true);
    setProgress(null);
    setResult(null);
    setMessage('');
    setMessageIsError(false);
    try {
      const generated = await apiRequest<ImageGenerationResult>('/api/image-generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, runId: nextRunId }),
      });
      setResult(generated);
      setMessage(completionMessage(request.mode));
      await refreshProgress(nextRunId).catch(() => {});
      return generated;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '图片生成失败');
      setMessageIsError(true);
      await refreshProgress(nextRunId).catch(() => {
        forgetRun();
        setProgress(null);
      });
      return null;
    } finally {
      if (activeRunId.current === nextRunId) setBusy(false);
    }
  }

  return {
    runId,
    busy,
    openingRunId,
    progress,
    result,
    message,
    messageIsError,
    showMessage,
    openRun,
    startRun,
  };
}
