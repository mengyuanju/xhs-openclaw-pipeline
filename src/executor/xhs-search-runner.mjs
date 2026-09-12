import { setTimeout as delay } from 'node:timers/promises';

import {
  XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
  XiaohongshuSearchBlockedError,
  xiaohongshuSearchExecutionOptions,
} from '../xhs-query-search.mjs';

export async function executeXhsQuerySearchOnce({
  controlPlane,
  browser,
  nodeId,
  nodeName,
  accountLabel,
  hostKind,
}) {
  const claim = await controlPlane.claimXhsQuerySearch({
    nodeId,
    ...(nodeName ? { nodeName } : {}),
    ...(accountLabel ? { accountLabel } : {}),
    ...(hostKind ? { hostKind } : {}),
    protocolVersion: XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
  });
  if (!claim) return { status: 'IDLE' };
  const searchOptions = xiaohongshuSearchExecutionOptions({
    resultLimit: claim.resultLimit,
    searchMode: claim.searchMode,
  });
  let links;
  try {
    links = await browser.search(claim.query, searchOptions);
  } catch (error) {
    if (error instanceof XiaohongshuSearchBlockedError) {
      const job = await controlPlane.blockXhsQuerySearch(claim.id, {
        leaseToken: claim.leaseToken,
        reason: error.code,
      });
      return { status: 'BLOCKED', reason: error.code, claim, job };
    }
    const job = await controlPlane.failXhsQuerySearch(claim.id, {
      leaseToken: claim.leaseToken,
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
    });
    return { status: job.status, claim, job, error };
  }
  const job = await controlPlane.completeXhsQuerySearch(claim.id, {
    leaseToken: claim.leaseToken,
    links,
  });
  return { status: 'SUCCEEDED', claim, job };
}

export async function runXhsQuerySearch({
  controlPlane,
  browser,
  nodeId,
  nodeName,
  accountLabel,
  hostKind,
  pollMs = 8_000,
  once = false,
  signal,
  wait = delay,
  onOutcome = () => {},
}) {
  while (!signal?.aborted) {
    const outcome = await executeXhsQuerySearchOnce({
      controlPlane,
      browser,
      nodeId,
      nodeName,
      accountLabel,
      hostKind,
    });
    onOutcome(outcome);
    if (once || outcome.status === 'BLOCKED') return outcome;
    await wait(pollMs, undefined, signal ? { signal } : undefined).catch((error) => {
      if (error?.name !== 'AbortError') throw error;
    });
  }
  return { status: 'STOPPED' };
}
