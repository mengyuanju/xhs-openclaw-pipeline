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
};

export function StatusPill({ value }: { value?: string | null }) {
  const status = value || 'NOT_READY';
  return <span className={`pill pill-${status.toLowerCase()}`}>{LABELS[status] || status}</span>;
}
