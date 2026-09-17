export type StateGroup = 'queued' | 'running' | 'copyReview' | 'imageReview' | 'failed' | 'completed' | 'cancelled';
export type Counts = {
  total: number; createdInPeriod: number; completedInPeriod: number; todayCreated: number;
  todayCompleted: number; completed: number; pending: number; cancelled: number; anomalies: number;
};
export type Worker = { accountId: number | null; username: string | null; displayName: string; role: string | null };
export type Person = Worker & Counts & {
  receivedInPeriod: number; todayReceived: number; stale: number; legacyFallback: number;
};
export type CompletedWorkTask = {
  id: number; query: string; state: string; stages: Array<'COPY' | 'IMAGE'>;
  copyCompletedAt: string | null; imageCompletedAt: string | null; latestCompletedAt: string;
};
export type CompletedWork = {
  total: number; copy: number; image: number; overlap: number;
  states: Record<string, number>; tasks: CompletedWorkTask[];
};
export type Summary = Counts & {
  states: Record<StateGroup, number>; copyQaReturned: number; people?: Person[];
  trend: { date: string; created: number; completed: number }[];
  missingDates: number; staleCount: number; legacyOwnerFallback: number;
  completedWork?: CompletedWork;
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
export type PersonQuality = {
  accountId: number | null; username: string | null; samples: number; qualified: number; passRate: number | null;
};
export type Efficiency = {
  copy: ExecutionStats; image: ExecutionStats; delivery: Distribution;
  effectiveImages: number; simulated: number; executionTasks: number; repeatedTasks: number; repeatRate: number | null;
  quality: { copy: QualityStats; image: QualityStats };
  peopleQuality: PersonQuality[];
  trend: { date: string; copyMs: number | null; imageMs: number | null }[];
  total: number; loaded: number; state: 'ready' | 'loading' | 'partial'; failed: number; updatedAt: string | null;
};
export type Statistics = {
  scope: 'personal' | 'admin'; range: { from: string; to: string };
  summary: Summary | null; workers?: Worker[]; details: Efficiency | null;
  state: 'ready' | 'loading' | 'refreshing' | 'error'; progress: { loaded: number; total: number | null };
  updatedAt: string | null; notice: string | null; retryAfterMs: number;
};
export type Period = 'today' | '7d' | '30d' | 'custom';
export type PersonalStatisticsRange = { period: Period; from?: string; to?: string };
export type Filters = { scope: 'personal' | 'admin'; period: Period; from?: string; to?: string; username?: string; workerAccountId?: number; role?: string; details?: boolean };
