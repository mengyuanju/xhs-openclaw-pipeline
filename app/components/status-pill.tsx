const LABELS: Record<string, string> = {
  pending: '待处理',
  processing: '生成中',
  completed: '已生成',
  failed: '失败',
  PREVIEW: '待确认',
  COMMITTED: '已入队',
  NOT_READY: '未就绪',
  WAITING_REVIEW: '待审核',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  PUBLISHED: '使用中',
  DRAFT: '草稿',
  TESTING: '测试中',
  RETIRED: '历史',
  STRONG: '强需',
  MEDIUM: '中需',
  WEAK: '弱需',
  NONE: '无需',
  SCREENED: '筛选完成',
  PENDING_SCREENING: '待筛选',
  NOT_APPLICABLE: '无需验收',
  UNVERIFIED: '未验收',
  PASSED: '图文匹配',
  FAILED: '验收失败',
  STALE: '文案已变更',
  MANUAL_REQUIRED: '需重新验收',
};

export function StatusPill({ value }: { value?: string | null }) {
  const status = value || 'NOT_READY';
  return <span className={`pill pill-${status.toLowerCase()}`}>{LABELS[status] || status}</span>;
}
