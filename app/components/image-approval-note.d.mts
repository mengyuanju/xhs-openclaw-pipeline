export type ImageApprovalEvent = {
  id: number;
  imageRunId: string;
  copyRevisionId: number;
  manualModificationNote: string | null;
  submittedAt: string;
};

export function imageApprovalNoteForVersion(
  events: unknown,
  imageRunId: string | null,
  copyRevisionId: number | null,
): string | null;
