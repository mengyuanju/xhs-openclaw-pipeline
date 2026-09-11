export type XhsSearchNodeStatus = {
  id: string;
  name: string;
  accountLabel: string | null;
  hostKind: 'CENTER' | 'EXECUTOR';
  online: boolean;
  authStatus: 'UNKNOWN' | 'READY' | 'LOGIN_REQUIRED' | 'CAPTCHA_REQUIRED';
  authStatusChangedAt: string;
  authCheckedAt: string | null;
  lastJobId: number | null;
  lastJobStatus: string | null;
  lastJobTaskId: number | null;
  runningJobId: number | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

export function xhsSearchNeedsAttention(node: XhsSearchNodeStatus) {
  return node.authStatus === 'LOGIN_REQUIRED' || node.authStatus === 'CAPTCHA_REQUIRED';
}

export function xhsAuthStatusLabel(node: XhsSearchNodeStatus) {
  if (node.authStatus === 'LOGIN_REQUIRED') return '需要重新登录';
  if (node.authStatus === 'CAPTCHA_REQUIRED') return '需要安全验证';
  if (node.authStatus === 'READY') return '最近验证正常';
  return node.runningJobId ? '正在验证账号' : '等待首次验证';
}

export function xhsHostKindLabel(node: XhsSearchNodeStatus) {
  return node.hostKind === 'CENTER' ? '中心服务器' : '执行机';
}
