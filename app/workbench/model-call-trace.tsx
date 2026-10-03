'use client';

import { Disclosure, DisclosureTrigger, DisclosureContent } from '@/components/ui/disclosure';
import { Button } from '@/components/ui/button';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { apiRequest } from '../components/api-client';
import { ModelRequestDetails } from './model-request-details';
import { safeDoubaoSearchDiagnostic } from './research-attempt-diagnostic.mjs';

const ModelResponseView = dynamic(() => import('./model-response-view').then((module) => module.ModelResponseView), {
  loading: () => <p role="status">正在准备阅读视图…</p>,
});

type Call = {
  id: string; executionId: string; sequence: number; stage: string; kind: string; nodeId: string;
  provider: string; operation: string; model: string; status: string; truncated: boolean;
  startedAt: string; executionStartedAt: string; durationMs: number | null;
  prompt?: string; request?: string; response?: string | null; error?: string | null;
};
type Page = { items: Call[]; total: number; cleanup?: {
  status: 'PENDING' | 'DEFERRED' | 'COMPLETE'; deletedCount: number; completedAt: string | null;
} | null };
export type ResearchSnapshot = {
  provider?: string | null;
  query?: string;
  searchedAt?: string;
  summary?: string | null;
  attempts?: Array<{ provider?: string; status?: 'COMPLETED' | 'FAILED'; error?: string | null }>;
  sources?: Array<{ title?: string; url: string; siteName?: string; provider?: string }>;
};
const PAGE_SIZE = 20;
const OPERATIONS: Record<string, string> = {
  TEXT: '文本生成', WEB_SEARCH: '联网搜索', WEB_SEARCH_RETRY: '联网搜索重试', WEB_SEARCH_FINALIZE: '整理已有搜索结果', IMAGE: '图片生成', IMAGE_EDIT: '图片编辑', VISION: '图片分析',
};
const STAGES: Record<string, string> = {
  SEARCHING_IMAGES: '联网搜索图片', PREPARING: '生图准备', PLANNING: '画面规划',
  ALIGNING: '图片校验与对齐', QUALITY_CHECK: '图片质检',
  ORIGINAL_REVIEW: '首稿质检', REVIEWED_GENERATION: '文案改写', REVIEWED_REVIEW: '改写稿质检',
  STARTING: '准备中', QUERY_REVIEW: '选题审核', KNOWLEDGE_MATCH: '优秀案例匹配', RESEARCH: '资料搜索与整理',
  ORIGINAL_GENERATION: '文案与配图策划', TEXT_GENERATION: '文案生成',
  COPY_LENGTH_REPAIR: '正文定向修复', COPY_CONTRACT_REPAIR: '文案格式修复',
  TEXT_REVIEW: '文案质检', TEXT_REVISION: '文案改写', IMAGE_PLANNING: '配图策划',
  VISUAL_PLANNING: '视觉策划', IMAGE_GENERATION: '图片生成', IMAGE_REVIEW: '图片质检',
  GENERATING: '图片生成', VALIDATING: '图片校验', IMAGE_SEARCH: '图片搜索',
};
const stageLabel = (item: Call) => ['WEB_SEARCH_RETRY', 'WEB_SEARCH_FINALIZE'].includes(item.operation)
  ? OPERATIONS[item.operation]
  : STAGES[item.stage] ?? OPERATIONS[item.operation] ?? '模型调用';
const STAGE_HINTS: Record<string, string> = {
  COPY_LENGTH_REPAIR: '修复正文长度或残句，沿用标题、来源和配图策划',
  COPY_CONTRACT_REPAIR: '仅修复未通过校验的字段及必要联动',
};
const OPERATION_HINTS: Record<string, string> = {
  WEB_SEARCH_RETRY: '搜索服务未返回完整调用，执行一次限次重试',
  WEB_SEARCH_FINALIZE: '仅整理已有证据，不会再次联网搜索',
};
const STATUSES: Record<string, string> = { RUNNING: '等待返回', SUCCEEDED: '已返回', FAILED: '调用失败' };
const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const basePath = (taskId: number) => `/api/control-plane/v1/tasks/${taskId}/model-calls`;

function safeSnapshotText(value: unknown, limit: number) {
  if (typeof value !== 'string') return '';
  return value.replace(/\bsk-[a-zA-Z0-9_-]{8,}/gu, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"',}]+/giu, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|password|secret|access[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s"',}\n]+/giu, '$1[REDACTED]')
    .replace(/\u0000/gu, '').slice(0, limit).trim();
}

function researchProviderLabel(value: unknown) {
  const provider = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(provider)) return '未记录';
  return ({ doubao: '豆包', deepseek: 'DeepSeek', codex: 'Codex' } as Record<string, string>)[provider] ?? provider;
}

function ResearchSnapshotCard({ research, copyRevisionId, researchExecutionId }: {
  research: ResearchSnapshot;
  copyRevisionId?: number;
  researchExecutionId?: string | null;
}) {
  const query = safeSnapshotText(research.query, 500);
  const summary = safeSnapshotText(research.summary, 6_000);
  const attempts = Array.isArray(research.attempts) ? research.attempts.slice(0, 5) : [];
  const sourceCount = Array.isArray(research.sources) ? research.sources.length : 0;
  const searchedAt = typeof research.searchedAt === 'string' && Number.isFinite(Date.parse(research.searchedAt))
    ? formatTime(research.searchedAt) : '未记录';
  return <section className="model-call-body workbench-review-section" aria-label="当前文案保存的搜索记录">
    <h4>当前文案保存的搜索记录 · {researchProviderLabel(research.provider)} · {sourceCount} 条来源</h4>
    <p className="model-call-note">来自文案版本 {copyRevisionId ?? '未记录'} 保存的研究快照，不包含完整 HTTP 请求与响应；详细调用以链路记录为准。此摘要不计入模型调用次数。</p>
    <p className="model-call-note">所属执行：{researchExecutionId || '未记录'} · 搜索时间：{searchedAt}</p>
    <p className="model-call-note">研究词（非完整 HTTP 请求）：{query || '未记录'}</p>
    {!!attempts.length && <p className="model-call-note">服务尝试：{attempts.map((attempt, index) => {
      const diagnostic = attempt.status === 'FAILED' && typeof attempt.provider === 'string' && attempt.provider.toLowerCase() === 'doubao'
        ? safeDoubaoSearchDiagnostic(attempt.error) : null;
      return `${index + 1}. ${researchProviderLabel(attempt.provider)}（${attempt.status === 'COMPLETED' ? '已返回来源' : attempt.status === 'FAILED' ? '失败' : '未记录状态'}${diagnostic ? `：${diagnostic}` : ''}）`;
    }).join(' → ')}</p>}
    {summary && <Disclosure className="model-call-request"><DisclosureTrigger>研究摘要（已脱敏）</DisclosureTrigger><DisclosureContent>
      <pre>{summary}</pre>
    </DisclosureContent></Disclosure>}
    <p className="model-call-note">具体来源链接可在“联网资料来源”中核对。</p>
  </section>;
}

function CallCard({ taskId, item }: { taskId: number; item: Call }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Call | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setError(''); setDetail(null);
    apiRequest<Call>(`${basePath(taskId)}/${item.id}`, { signal: abort.signal })
      .then(setDetail).catch((cause) => { if (!abort.signal.aborted) setError(cause.message); });
    return () => abort.abort();
  }, [open, taskId, item.id, revision]);

  return <Disclosure className="model-call-card" open={open} onOpenChange={setOpen}>
    <DisclosureTrigger>
      <span><strong>第 {item.sequence} 步 · {stageLabel(item)}</strong>
        <small>{item.provider} · {item.model || (item.provider.toLowerCase() === 'doubao' && item.operation === 'WEB_SEARCH' ? '搜索服务' : '未暴露模型名称')} · {OPERATIONS[item.operation] ?? '模型调用'}</small></span>
      {(STAGE_HINTS[item.stage] || OPERATION_HINTS[item.operation]) && <small>{STAGE_HINTS[item.stage] ?? OPERATION_HINTS[item.operation]}</small>}
      <span className={`model-call-status ${item.status === 'FAILED' ? 'is-failed' : ''}`}>
        {STATUSES[item.status] ?? '未知状态'}{item.durationMs !== null ? ` · ${(item.durationMs / 1000).toFixed(1)} 秒` : ''}
      </span>
    </DisclosureTrigger><DisclosureContent>
    {open && <div className="model-call-body">
      <p className="model-call-note">调用时间：{formatTime(item.startedAt)}</p>
      {error && <div role="alert" className="notice error">{error} <Button unstyled className="button" type="button" onClick={() => setRevision((value) => value + 1)}>重试加载</Button></div>}
      {!detail && !error && <p role="status">正在加载提示词与返回内容…</p>}
      {detail && <>
        {detail.truncated && <p className="notice warning">记录内容过长，已截断展示；并非完整原文。</p>}
        <ModelRequestDetails detail={detail} />
        <Disclosure className="model-call-request"><DisclosureTrigger>{detail.truncated ? '提示词记录（可能已截断）' : '完整提示词原文（已脱敏）'}</DisclosureTrigger><DisclosureContent><pre>{detail.prompt || '此调用未提供文本提示词。'}</pre></DisclosureContent></Disclosure>
        <h4>{item.operation.startsWith('WEB_SEARCH') ? '搜索结果（已脱敏）' : '模型返回内容'}</h4>
        {detail.response != null ? <ModelResponseView text={detail.response} /> : <p className="model-call-note">{detail.status === 'RUNNING' ? '暂未记录返回：调用可能仍在执行，或执行机已中断。' : '未取得返回内容。'}</p>}
        {detail.error && <><h4>调用错误</h4><pre className="model-call-error">{detail.error}</pre></>}
      </>}
    </div>}
  </DisclosureContent></Disclosure>;
}

export function ModelCallTrace({ taskId, researchSnapshot, copyRevisionId, researchExecutionId }: {
  taskId: number;
  researchSnapshot?: ResearchSnapshot;
  copyRevisionId?: number;
  researchExecutionId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setError(''); setData(null);
    apiRequest<Page>(`${basePath(taskId)}?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`, { signal: abort.signal })
      .then(setData).catch((cause) => { if (!abort.signal.aborted) setError(cause.message); });
    return () => abort.abort();
  }, [open, taskId, page, revision]);
  useEffect(() => {
    if (data && page > 0 && page * PAGE_SIZE >= data.total) setPage(Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1));
  }, [data, page]);

  return <Disclosure className="model-call-trace workbench-review-section" open={open} onOpenChange={setOpen}>
    <DisclosureTrigger><strong>模型调用链路</strong><span>{open ? '收起' : '展开查看每一步的提示词与返回内容'}</span></DisclosureTrigger><DisclosureContent>
    {open && <div className="model-call-trace-content">
      <p className="model-call-note">按执行轮次和调用顺序记录，重试单独保留。这里展示项目实际发送和收到的内容（已脱敏）；模型客户端及服务商内部未返回的子调用不可见。“已返回”不代表业务校验通过。</p>
      {researchSnapshot && <ResearchSnapshotCard research={researchSnapshot} copyRevisionId={copyRevisionId} researchExecutionId={researchExecutionId} />}
      <div className="model-call-toolbar"><span>{data ? `共 ${data.total} 次调用` : '模型调用记录'}</span>
        <Button unstyled type="button" className="button" onClick={() => setRevision((value) => value + 1)}>刷新记录</Button></div>
      {error && <div role="alert" className="notice error">加载失败：{error}。请确认中心服务已升级，可点击刷新重试。</div>}
      {!data && !error && <p role="status">正在加载调用链路…</p>}
      {data?.cleanup?.status === 'COMPLETE' && <p className="model-call-note">已进入交付池，交付前的模型调用记录已按策略清理{data.cleanup.completedAt ? `（${formatTime(data.cleanup.completedAt)}）` : ''}。文案、图片和质检结果仍保留。{data.total > 0 ? '下方为后续执行的调用记录。' : ''}</p>}
      {data?.cleanup && data.cleanup.status !== 'COMPLETE' && <p className="model-call-note">交付前的调用记录正在分批清理，执行中的记录会延后处理。</p>}
      {data?.items.length === 0 && !data.cleanup && <p className="model-call-empty">暂无模型调用记录。旧任务或未升级执行机的任务可能没有记录，无法还原当时的提示词与返回内容。</p>}
      {data?.items.map((item, index) => <div key={item.id}>
        {(index === 0 || item.executionId !== data.items[index - 1].executionId) && <div className="model-call-execution">
          <strong>{item.kind === 'COPY' ? '文案执行' : '生图执行'} · {formatTime(item.executionStartedAt)}</strong>
          <small>执行机：{item.nodeId} · 执行编号：{item.executionId}</small>
        </div>}
        <CallCard taskId={taskId} item={item} />
      </div>)}
      {data && (data.total > PAGE_SIZE || page > 0) && <div className="model-call-toolbar">
        <Button unstyled type="button" className="button" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</Button>
        <span>第 {page + 1} 页 / 共 {Math.max(1, Math.ceil(data.total / PAGE_SIZE))} 页</span>
        <Button unstyled type="button" className="button" disabled={(page + 1) * PAGE_SIZE >= data.total} onClick={() => setPage(page + 1)}>下一页</Button>
      </div>}
    </div>}
  </DisclosureContent></Disclosure>;
}
