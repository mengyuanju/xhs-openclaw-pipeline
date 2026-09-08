export type StateGroup = 'queued' | 'running' | 'copyReview' | 'imageReview' | 'failed' | 'completed' | 'cancelled';
export type Counts = {
  total: number; createdInPeriod: number; completedInPeriod: number; todayCreated: number;
  todayCompleted: number; completed: number; pending: number; cancelled: number; anomalies: number;
};
export type Creator = { accountId: number | null; username: string | null; displayName: string; role: string | null };
export type Person = Creator & Counts;
export type Summary = Counts & {
  states: Record<StateGroup, number>; people?: Person[];
  trend: { date: string; created: number; completed: number }[];
  missingDates: number; staleCount: number;
  stale?: { id: number; query: string; username: string | null; hours: number }[];
};
export type Distribution = { samples: number; meanMs: number | null; medianMs: number | null; p90Ms: number | null };
export type ExecutionStats = Distribution & {
  failed: number; succeeded: number; abandoned: number; invalid: number; failureRate: number | null;
};
export type QualityStats = {
  samples: number; threePoint: number; qualified: number;
  threePointRate: number | null; qualifiedRate: number | null;
};
export type Efficiency = {
  copy: ExecutionStats; image: ExecutionStats; delivery: Distribution;
  effectiveImages: number; simulated: number; executionTasks: number; repeatedTasks: number; repeatRate: number | null;
  quality: { copy: QualityStats; image: QualityStats };
  trend: { date: string; copyMs: number | null; imageMs: number | null }[];
  total: number; loaded: number; state: 'ready' | 'loading' | 'partial'; failed: number; updatedAt: string | null;
};
export type Statistics = {
  scope: 'personal' | 'admin'; range: { from: string; to: string };
  summary: Summary | null; creators?: Creator[]; details: Efficiency | null;
  state: 'ready' | 'loading' | 'refreshing' | 'error'; progress: { loaded: number; total: number | null };
  updatedAt: string | null; notice: string | null; retryAfterMs: number;
};
export type Period = 'today' | '7d' | '30d' | 'custom';
export type Filters = { scope: 'personal' | 'admin'; period: Period; from?: string; to?: string; username?: string; createdByAccountId?: number; role?: string; details?: boolean };
